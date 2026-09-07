use bincode::Options;
#[cfg(unix)]
use memmap2::Advice;
use memmap2::Mmap;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::hash::{BuildHasherDefault, Hasher};
use std::io::{BufWriter, Write};
use std::mem::{align_of, size_of};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use std::time::SystemTime;

#[derive(Default)]
struct IntegerHasher(u64);

impl Hasher for IntegerHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        let mut value = 0_u64;
        for (shift, byte) in bytes.iter().take(8).enumerate() {
            value |= u64::from(*byte) << (shift * 8);
        }
        self.0 = value;
    }

    fn write_u32(&mut self, value: u32) {
        self.0 = u64::from(value);
    }

    fn write_i32(&mut self, value: i32) {
        self.0 = u64::from(value as u32);
    }
}

type IntegerHashSet<T> = HashSet<T, BuildHasherDefault<IntegerHasher>>;

mod snapshot_validation;
mod street_snapshot;
mod timetable;
mod timetable_validation;
pub use timetable::*;
mod street_analysis;
pub use street_analysis::*;
mod terminal_access;
use terminal_access::{TerminalAccessGraph, TerminalAttachment};
mod exact_routing;
pub use exact_routing::*;
#[cfg(test)]
mod routing_query_tests;

use street_snapshot::Snapshot;

const SNAP_RADIUS_M: f64 = 80.0;
const RECOVERY_SNAP_RADIUS_M: f64 = 160.0;
const ACCESS_GRID_DEGREES: f64 = 0.002;
const EARTH_RADIUS_M: f64 = 6_371_008.8;
const NO_PREDECESSOR: u32 = u32::MAX;
const NO_PROFILE_KEY: u32 = u32::MAX;
// A whole Matrix group may reuse its endpoint preparation for direct walking.
// The existing per-role byte limit remains the controlling memory bound.
const MAXIMUM_ENDPOINT_CACHE_ENTRIES: usize = MAXIMUM_MATRIX_PAIRS;
const MAXIMUM_ENDPOINT_CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAXIMUM_MATRIX_PAIRS: usize = 100_000;
// The scaled spherical metric is an exact lower-bound certificate for every
// path inside the bounded latitude band; it prunes work but never guides order.
const POINT_PATH_METRIC_LOWER_BOUND_FACTOR: f64 = 1.0;
const ACCESS_PROFILE_SNAPSHOT_MAGIC: [u8; 8] = *b"VIGOAP04";
const ACCESS_PROFILE_SNAPSHOT_VERSION: u32 = 4;
const ACCESS_PROFILE_SNAPSHOT_HEADER_BYTES: usize = 80;
const MAXIMUM_ACCESS_PROFILE_SNAPSHOT_BYTES: u64 = 4_u64 * 1024 * 1024 * 1024;
// One-tenth-millimetre quantization keeps even thousand-edge walks within
// ten centimetres while retaining 214.7 km of finite u32 distance headroom.
// The public arbitrary-coordinate walk envelope is 50 km, so the CCH can now
// serve every legal request without a distance-range fallback.
const CCH_DISTANCE_UNITS_PER_METER: f64 = 10_000.0;
const CCH_MAXIMUM_QUERY_DISTANCE_M: f64 = 5_000.0;
const ENDPOINT_ACCESS_THREAD_COUNT: usize = 2;

// A single coordinate OD has exactly two independent directed street-access
// roles. A private two-worker pool avoids both global-pool oversubscription and
// per-request thread creation, while leaving offline/batch Rayon work free to
// use the process-wide pool. If the private pool cannot be created, the exact
// operations run sequentially rather than changing routing semantics.
static ENDPOINT_ACCESS_POOL: LazyLock<Option<rayon::ThreadPool>> = LazyLock::new(|| {
    rayon::ThreadPoolBuilder::new()
        .num_threads(ENDPOINT_ACCESS_THREAD_COUNT)
        .thread_name(|index| format!("vigo-endpoint-access-{index}"))
        .build()
        .ok()
});

#[cfg(unix)]
fn prefetch_street_snapshot(snapshot_path: String) {
    // macOS may satisfy MADV_WILLNEED synchronously. Run the hint on a
    // detached mapping so native construction returns immediately while the
    // filesystem cache is populated in parallel with GTFS/profile setup.
    let _ = std::thread::Builder::new()
        .name("vigo-street-prefetch".to_owned())
        .spawn(move || {
            let Ok(file) = File::open(snapshot_path) else {
                return;
            };
            let Ok(mmap) = (unsafe { Mmap::map(&file) }) else {
                return;
            };
            let _ = mmap.advise(Advice::WillNeed);
        });
}

fn join_endpoint_access<Left, Right, LeftResult, RightResult>(
    left: Left,
    right: Right,
) -> (LeftResult, RightResult)
where
    Left: FnOnce() -> LeftResult + Send,
    Right: FnOnce() -> RightResult + Send,
    LeftResult: Send,
    RightResult: Send,
{
    match ENDPOINT_ACCESS_POOL.as_ref() {
        Some(pool) => pool.install(|| rayon::join(left, right)),
        None => (left(), right()),
    }
}

#[cfg(test)]
mod cch_bundle_safety_tests;
#[cfg(test)]
mod snapshot_bounds_tests;

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Snap {
    node: u32,
    distance_m: f64,
}

#[derive(Clone, Copy)]
struct ReciprocalEdgeSnap {
    left: Snap,
    right: Snap,
    projection_distance_m: f64,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Target {
    member: u32,
    snap_distance_m: f64,
}

#[derive(Clone, Copy)]
struct PointHeapEntry {
    node: u32,
    distance_m: f64,
    priority_m: f64,
}

impl PartialEq for PointHeapEntry {
    fn eq(&self, other: &Self) -> bool {
        self.node == other.node
            && self.distance_m.to_bits() == other.distance_m.to_bits()
            && self.priority_m.to_bits() == other.priority_m.to_bits()
    }
}

impl Eq for PointHeapEntry {}

impl PartialOrd for PointHeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PointHeapEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .priority_m
            .total_cmp(&self.priority_m)
            .then_with(|| other.distance_m.total_cmp(&self.distance_m))
            .then_with(|| other.node.cmp(&self.node))
    }
}

#[derive(Clone, Copy)]
struct TileRange {
    global_start: u32,
    global_end: u32,
    local_start: usize,
}

struct TileWorkspace {
    distances: Vec<f64>,
    origin_snap_distances: Vec<f64>,
    generations: Vec<u32>,
    predecessors: Vec<u32>,
    predecessor_first_nodes: Vec<u32>,
    target_generations: Vec<u32>,
    ranges: Vec<TileRange>,
    active_member_generations: Vec<u32>,
    active_member_offsets: Vec<u32>,
    active_member_generation: u32,
    generation: u32,
    target_generation: u32,
    local_len: usize,
    queue: BinaryHeap<PointHeapEntry>,
    point_queue: BinaryHeap<PointHeapEntry>,
}

impl TileWorkspace {
    fn new() -> Self {
        Self {
            distances: Vec::new(),
            origin_snap_distances: Vec::new(),
            generations: Vec::new(),
            predecessors: Vec::new(),
            predecessor_first_nodes: Vec::new(),
            target_generations: Vec::new(),
            ranges: Vec::new(),
            active_member_generations: Vec::new(),
            active_member_offsets: Vec::new(),
            active_member_generation: 0,
            generation: 0,
            target_generation: 0,
            local_len: 0,
            queue: BinaryHeap::with_capacity(16_384),
            point_queue: BinaryHeap::with_capacity(16_384),
        }
    }

    fn begin(
        &mut self,
        snapshot: &Snapshot,
        longitude: f64,
        latitude: f64,
        maximum_distance_m: f64,
    ) -> napi::Result<u32> {
        self.ranges = spatial_tile_ranges(
            snapshot,
            longitude,
            latitude,
            maximum_distance_m + RECOVERY_SNAP_RADIUS_M,
        )?;
        self.local_len = self
            .ranges
            .last()
            .map(|range| range.local_start + (range.global_end - range.global_start) as usize)
            .unwrap_or(0);
        if self.distances.len() < self.local_len {
            self.distances.resize(self.local_len, 0.0);
            self.origin_snap_distances.resize(self.local_len, 0.0);
            self.generations.resize(self.local_len, 0);
            self.predecessors.resize(self.local_len, NO_PREDECESSOR);
            self.predecessor_first_nodes
                .resize(self.local_len, NO_PREDECESSOR);
            self.target_generations.resize(self.local_len, 0);
        }
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.generations.fill(0);
            self.generation = 1;
        }
        self.target_generation = self.target_generation.wrapping_add(1);
        if self.target_generation == 0 {
            self.target_generations.fill(0);
            self.target_generation = 1;
        }
        self.queue.clear();
        self.point_queue.clear();
        Ok(self.generation)
    }

    fn reserve_local_len(&mut self, local_len: usize) {
        if self.distances.len() >= local_len {
            return;
        }
        self.distances.resize(local_len, 0.0);
        self.origin_snap_distances.resize(local_len, 0.0);
        self.generations.resize(local_len, 0);
        self.predecessors.resize(local_len, NO_PREDECESSOR);
        self.predecessor_first_nodes
            .resize(local_len, NO_PREDECESSOR);
        self.target_generations.resize(local_len, 0);
    }

    #[inline(always)]
    fn local_location(&self, node: u32) -> Option<(usize, usize)> {
        if self.ranges.len() == 1 {
            let range = self.ranges[0];
            return (node >= range.global_start && node < range.global_end)
                .then_some(((node - range.global_start) as usize, 0));
        }
        let range_index = self
            .ranges
            .partition_point(|range| range.global_start <= node)
            .checked_sub(1)?;
        let range = self.ranges[range_index];
        (node < range.global_end).then_some((
            range.local_start + (node - range.global_start) as usize,
            range_index,
        ))
    }

    #[inline(always)]
    fn local_location_near(&self, node: u32, hint: usize) -> Option<(usize, usize)> {
        for range_index in [Some(hint), hint.checked_sub(1), hint.checked_add(1)]
            .into_iter()
            .flatten()
        {
            let Some(range) = self.ranges.get(range_index).copied() else {
                continue;
            };
            if node >= range.global_start && node < range.global_end {
                return Some((
                    range.local_start + (node - range.global_start) as usize,
                    range_index,
                ));
            }
        }
        self.local_location(node)
    }

    #[inline(always)]
    fn local_offset(&self, node: u32) -> Option<usize> {
        self.local_location(node).map(|location| location.0)
    }

    fn mark_target_node(&mut self, node: u32) {
        if let Some(offset) = self.local_offset(node) {
            self.target_generations[offset] = self.target_generation;
        }
    }

    #[inline(always)]
    fn is_target_local(&self, local_node: usize) -> bool {
        self.target_generations[local_node] == self.target_generation
    }

    fn begin_target_members(&mut self, member_count: usize) {
        if self.active_member_generations.len() != member_count {
            self.active_member_generations = vec![0; member_count];
            self.active_member_offsets = vec![0; member_count];
            self.active_member_generation = 1;
            return;
        }
        self.active_member_generation = self.active_member_generation.wrapping_add(1);
        if self.active_member_generation == 0 {
            self.active_member_generations.fill(0);
            self.active_member_generation = 1;
        }
    }

    fn activate_target_member(&mut self, member: u32, member_offset: u32) {
        let member = member as usize;
        self.active_member_generations[member] = self.active_member_generation;
        self.active_member_offsets[member] = member_offset;
    }

    #[inline(always)]
    fn active_target_member_offset(&self, member: u32) -> Option<usize> {
        let member = member as usize;
        (self.active_member_generations[member] == self.active_member_generation)
            .then_some(self.active_member_offsets[member] as usize)
    }

    fn byte_length(&self) -> usize {
        self.distances.capacity() * size_of::<f64>()
            + self.origin_snap_distances.capacity() * size_of::<f64>()
            + self.generations.capacity() * size_of::<u32>()
            + self.predecessors.capacity() * size_of::<u32>()
            + self.predecessor_first_nodes.capacity() * size_of::<u32>()
            + self.target_generations.capacity() * size_of::<u32>()
            + self.ranges.capacity() * size_of::<TileRange>()
            + self.active_member_generations.capacity() * size_of::<u32>()
            + self.active_member_offsets.capacity() * size_of::<u32>()
            + self.queue.capacity() * size_of::<PointHeapEntry>()
            + self.point_queue.capacity() * size_of::<PointHeapEntry>()
    }
}

struct DynamicCchQuery {
    // Zero means untouched; finite distances are stored as distance + 1.
    // This keeps construction backed by lazy zero pages without adding a
    // second random generation-array read to every hot CCH relaxation.
    distances: Vec<u32>,
    distance_sources: Vec<u32>,
    distance_touched: Vec<u32>,
    source_generations: Vec<u32>,
    target_generations: Vec<u32>,
    generation: u32,
    forward_nodes: Vec<u32>,
    target_nodes: Vec<u32>,
    target_ends: Vec<u32>,
    stack: Vec<u32>,
    output: Vec<u32>,
    bucket_distances: Vec<u32>,
    bucket_sources: Vec<u32>,
    bucket_generations: Vec<u32>,
    bucket_touched: Vec<u32>,
    bucket_output_targets: Vec<u32>,
    bucket_output_distances: Vec<u32>,
    bucket_output_sources: Vec<u32>,
}

impl DynamicCchQuery {
    fn new(node_count: usize) -> Self {
        Self {
            distances: vec![0; node_count],
            distance_sources: vec![0; node_count],
            distance_touched: Vec::new(),
            source_generations: vec![0; node_count],
            target_generations: vec![0; node_count],
            generation: 0,
            forward_nodes: Vec::new(),
            target_nodes: Vec::new(),
            target_ends: Vec::new(),
            stack: Vec::new(),
            output: Vec::new(),
            bucket_distances: Vec::new(),
            bucket_sources: Vec::new(),
            bucket_generations: Vec::new(),
            bucket_touched: Vec::new(),
            bucket_output_targets: Vec::new(),
            bucket_output_distances: Vec::new(),
            bucket_output_sources: Vec::new(),
        }
    }

    fn begin(&mut self) -> u32 {
        for node in self.distance_touched.drain(..) {
            self.distances[node as usize] = 0;
        }
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.source_generations.fill(0);
            self.target_generations.fill(0);
            self.bucket_generations.fill(0);
            self.generation = 1;
        }
        self.forward_nodes.clear();
        self.target_nodes.clear();
        self.target_ends.clear();
        self.stack.clear();
        self.output.clear();
        self.bucket_touched.clear();
        self.bucket_output_targets.clear();
        self.bucket_output_distances.clear();
        self.bucket_output_sources.clear();
        self.generation
    }

    #[inline(always)]
    fn offer_distance(&mut self, node: u32, distance: u32, _generation: u32) {
        let node_index = node as usize;
        let encoded_distance = distance.min(cch::INF_WEIGHT).saturating_add(1);
        let slot = &mut self.distances[node_index];
        if *slot == 0 {
            self.distance_touched.push(node);
            *slot = encoded_distance;
            return;
        }
        if encoded_distance >= *slot {
            return;
        }
        *slot = encoded_distance;
    }

    #[inline(always)]
    fn offer_distance_from(&mut self, node: u32, distance: u32, source: u32, _generation: u32) {
        let node_index = node as usize;
        let encoded_distance = distance.min(cch::INF_WEIGHT).saturating_add(1);
        let slot = &mut self.distances[node_index];
        if *slot == 0 {
            self.distance_touched.push(node);
            *slot = encoded_distance;
            self.distance_sources[node_index] = source;
            return;
        }
        if encoded_distance > *slot
            || (encoded_distance == *slot && source >= self.distance_sources[node_index])
        {
            return;
        }
        *slot = encoded_distance;
        self.distance_sources[node_index] = source;
    }

    #[inline(always)]
    fn distance(&self, node: u32, _generation: u32) -> u32 {
        let encoded_distance = self.distances[node as usize];
        if encoded_distance == 0 {
            cch::INF_WEIGHT
        } else {
            encoded_distance - 1
        }
    }

    fn distances(
        &mut self,
        cch: &cch::bundle::CchView<'_>,
        metric: &cch::bundle::MetricView<'_>,
        sources: &[(u32, u32)],
        targets: &[u32],
    ) -> &[u32] {
        let generation = self.begin();
        if sources.is_empty() || targets.is_empty() {
            self.output.resize(targets.len(), cch::INF_WEIGHT);
            return &self.output;
        }
        let elimination_tree_parent = cch.elimination_tree_parent;
        for &(source, initial_distance) in sources {
            let ranked_source = cch.rank[source as usize];
            self.offer_distance(ranked_source, initial_distance, generation);
            let mut node = ranked_source;
            while node != u32::MAX {
                if self.source_generations[node as usize] != generation {
                    self.source_generations[node as usize] = generation;
                    self.forward_nodes.push(node);
                }
                node = elimination_tree_parent[node as usize];
            }
        }
        // CCH internal ids are ranks; every up arc points to a larger id.
        // Ascending the union of all source ancestor paths is therefore a
        // topological multi-source forward sweep.
        self.forward_nodes.sort_unstable();
        for offset in 0..self.forward_nodes.len() {
            let node = self.forward_nodes[offset];
            let distance = self.distance(node, generation);
            if distance == cch::INF_WEIGHT {
                continue;
            }
            let start = cch.up_first_out[node as usize] as usize;
            let end = cch.up_first_out[node as usize + 1] as usize;
            for edge in start..end {
                let next = cch.up_head[edge];
                let candidate = distance
                    .saturating_add(metric.forward[edge])
                    .min(cch::INF_WEIGHT);
                self.offer_distance(next, candidate, generation);
            }
        }

        self.target_nodes.reserve(targets.len());
        self.target_ends.reserve(targets.len());
        for &target in targets {
            let ranked_target = cch.rank[target as usize];
            self.target_nodes.push(ranked_target);
            let mut node = ranked_target;
            let mut end = u32::MAX;
            while node != u32::MAX {
                if self.target_generations[node as usize] == generation {
                    end = node;
                    break;
                }
                self.target_generations[node as usize] = generation;
                node = elimination_tree_parent[node as usize];
            }
            self.target_ends.push(end);
        }
        for index in (0..self.target_nodes.len()).rev() {
            let mut node = self.target_nodes[index];
            let end = self.target_ends[index];
            while node != end {
                self.stack.push(node);
                node = elimination_tree_parent[node as usize];
            }
        }
        while let Some(node) = self.stack.pop() {
            let start = cch.up_first_out[node as usize] as usize;
            let end = cch.up_first_out[node as usize + 1] as usize;
            let mut best = self.distance(node, generation);
            for edge in start..end {
                let next_distance = self.distance(cch.up_head[edge], generation);
                if next_distance == cch::INF_WEIGHT {
                    continue;
                }
                best = best.min(
                    next_distance
                        .saturating_add(metric.backward[edge])
                        .min(cch::INF_WEIGHT),
                );
            }
            self.offer_distance(node, best, generation);
        }
        self.output.reserve(self.target_nodes.len());
        for &target in &self.target_nodes {
            self.output.push(self.distance(target, generation));
        }
        &self.output
    }

    /// Multi-source range query against profile-time target buckets. The
    /// bucket index stores the target-side half of every CCH meeting path, so
    /// a request only traverses the source ancestor union. This is a static
    /// graph/profile index, not an OD or endpoint-result cache.
    fn range_targets(
        &mut self,
        cch: &cch::bundle::CchView<'_>,
        forward_weights: &[u32],
        buckets: &CchTargetBuckets,
        sources: &[(u32, u32)],
        maximum_distance: u32,
        target_count: usize,
    ) -> (&[u32], &[u32], &[u32]) {
        let generation = self.begin();
        if sources.is_empty() || target_count == 0 {
            return (
                &self.bucket_output_targets,
                &self.bucket_output_distances,
                &self.bucket_output_sources,
            );
        }
        if self.bucket_distances.len() != target_count {
            self.bucket_distances = vec![cch::INF_WEIGHT; target_count];
            self.bucket_sources = vec![u32::MAX; target_count];
            self.bucket_generations = vec![0; target_count];
            self.bucket_touched.clear();
        }
        let elimination_tree_parent = cch.elimination_tree_parent;
        for &(source, initial_distance) in sources {
            if initial_distance > maximum_distance {
                continue;
            }
            let ranked_source = cch.rank[source as usize];
            self.offer_distance_from(ranked_source, initial_distance, source, generation);
            let mut node = ranked_source;
            while node != u32::MAX {
                if self.source_generations[node as usize] != generation {
                    self.source_generations[node as usize] = generation;
                    self.forward_nodes.push(node);
                }
                node = elimination_tree_parent[node as usize];
            }
        }
        self.forward_nodes.sort_unstable();
        let bucket_offsets = buckets.offsets();
        let bucket_entries = buckets.entries();
        for offset in 0..self.forward_nodes.len() {
            let node = self.forward_nodes[offset];
            let distance = self.distance(node, generation);
            if distance == cch::INF_WEIGHT || distance > maximum_distance {
                continue;
            }
            let edge_start = cch.up_first_out[node as usize] as usize;
            let edge_end = cch.up_first_out[node as usize + 1] as usize;
            for (edge_offset, &weight) in forward_weights[edge_start..edge_end].iter().enumerate() {
                let edge = edge_start + edge_offset;
                let candidate = distance.saturating_add(weight).min(cch::INF_WEIGHT);
                if candidate <= maximum_distance {
                    self.offer_distance_from(
                        cch.up_head[edge],
                        candidate,
                        self.distance_sources[node as usize],
                        generation,
                    );
                }
            }
            let bucket_start = bucket_offsets[node as usize] as usize;
            let bucket_end = bucket_offsets[node as usize + 1] as usize;
            for entry in &bucket_entries[bucket_start..bucket_end] {
                let candidate = distance.saturating_add(entry.distance);
                if candidate > maximum_distance {
                    // Each node bucket is sorted by target-side distance.
                    break;
                }
                let target = entry.target_index as usize;
                if self.bucket_generations[target] == generation
                    && candidate >= self.bucket_distances[target]
                {
                    continue;
                }
                if self.bucket_generations[target] != generation {
                    self.bucket_generations[target] = generation;
                    self.bucket_touched.push(entry.target_index);
                }
                self.bucket_distances[target] = candidate;
                self.bucket_sources[target] = self.distance_sources[node as usize];
            }
        }
        self.bucket_output_targets
            .reserve(self.bucket_touched.len());
        self.bucket_output_distances
            .reserve(self.bucket_touched.len());
        self.bucket_output_sources
            .reserve(self.bucket_touched.len());
        for &target in &self.bucket_touched {
            self.bucket_output_targets.push(target);
            self.bucket_output_distances
                .push(self.bucket_distances[target as usize]);
            self.bucket_output_sources
                .push(self.bucket_sources[target as usize]);
        }
        (
            &self.bucket_output_targets,
            &self.bucket_output_distances,
            &self.bucket_output_sources,
        )
    }

    fn byte_length(&self) -> usize {
        self.distances.capacity() * size_of::<u32>()
            + self.distance_sources.capacity() * size_of::<u32>()
            + self.distance_touched.capacity() * size_of::<u32>()
            + self.source_generations.capacity() * size_of::<u32>()
            + self.target_generations.capacity() * size_of::<u32>()
            + self.forward_nodes.capacity() * size_of::<u32>()
            + self.target_nodes.capacity() * size_of::<u32>()
            + self.target_ends.capacity() * size_of::<u32>()
            + self.stack.capacity() * size_of::<u32>()
            + self.output.capacity() * size_of::<u32>()
            + self.bucket_distances.capacity() * size_of::<u32>()
            + self.bucket_sources.capacity() * size_of::<u32>()
            + self.bucket_generations.capacity() * size_of::<u32>()
            + self.bucket_touched.capacity() * size_of::<u32>()
            + self.bucket_output_targets.capacity() * size_of::<u32>()
            + self.bucket_output_distances.capacity() * size_of::<u32>()
            + self.bucket_output_sources.capacity() * size_of::<u32>()
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CchBucketEntry {
    target_index: u32,
    distance: u32,
}

enum CchBucketStorage {
    Owned {
        offsets: Vec<u32>,
        entries: Vec<CchBucketEntry>,
    },
    Mapped {
        mmap: Arc<Mmap>,
        offsets_offset: usize,
        offsets_len: usize,
        entries_offset: usize,
        entries_len: usize,
    },
}

struct CchTargetBuckets {
    storage: CchBucketStorage,
    maximum_distance: u32,
}

struct CchMemberWorkspace {
    distances: Vec<u32>,
    terminals: Vec<u32>,
    sources: Vec<u32>,
    generations: Vec<u32>,
    generation: u32,
    touched: Vec<u32>,
}

impl CchMemberWorkspace {
    fn new() -> Self {
        Self {
            distances: Vec::new(),
            terminals: Vec::new(),
            sources: Vec::new(),
            generations: Vec::new(),
            generation: 0,
            touched: Vec::new(),
        }
    }

    fn begin(&mut self, member_count: usize) -> u32 {
        if self.distances.len() != member_count {
            self.distances = vec![cch::INF_WEIGHT; member_count];
            self.terminals = vec![NO_PREDECESSOR; member_count];
            self.sources = vec![NO_PREDECESSOR; member_count];
            self.generations = vec![0; member_count];
            self.generation = 0;
        }
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.generations.fill(0);
            self.generation = 1;
        }
        self.touched.clear();
        self.generation
    }

    fn byte_length(&self) -> usize {
        self.distances.capacity() * size_of::<u32>()
            + self.terminals.capacity() * size_of::<u32>()
            + self.sources.capacity() * size_of::<u32>()
            + self.generations.capacity() * size_of::<u32>()
            + self.touched.capacity() * size_of::<u32>()
    }
}

fn visit_cch_target_ancestors<F>(
    cch: &cch::bundle::CchView<'_>,
    backward_weights: &[u32],
    target: u32,
    maximum_distance: u32,
    distances: &mut [u32],
    touched: &mut Vec<u32>,
    mut visit: F,
) where
    F: FnMut(u32, u32),
{
    let ranked_target = cch.rank[target as usize];
    distances[ranked_target as usize] = 0;
    touched.push(ranked_target);
    let mut node = ranked_target;
    while node != u32::MAX {
        let distance = distances[node as usize];
        if distance <= maximum_distance {
            visit(node, distance);
            let start = cch.up_first_out[node as usize] as usize;
            let end = cch.up_first_out[node as usize + 1] as usize;
            for (edge_offset, &weight) in backward_weights[start..end].iter().enumerate() {
                let edge = start + edge_offset;
                let candidate = distance.saturating_add(weight);
                if candidate > maximum_distance {
                    continue;
                }
                let head = cch.up_head[edge];
                let slot = &mut distances[head as usize];
                if candidate < *slot {
                    if *slot == cch::INF_WEIGHT {
                        touched.push(head);
                    }
                    *slot = candidate;
                }
            }
        }
        node = cch.elimination_tree_parent[node as usize];
    }
    for node in touched.drain(..) {
        distances[node as usize] = cch::INF_WEIGHT;
    }
}

fn build_cch_target_buckets(
    cch: &cch::bundle::CchView<'_>,
    backward_weights: &[u32],
    targets: &[u32],
    maximum_distance: u32,
) -> napi::Result<CchTargetBuckets> {
    let node_count = cch.node_count() as usize;
    let mut distances = vec![cch::INF_WEIGHT; node_count];
    let mut touched = Vec::<u32>::new();
    let mut counts = vec![0_u32; node_count];
    for &target in targets {
        visit_cch_target_ancestors(
            cch,
            backward_weights,
            target,
            maximum_distance,
            &mut distances,
            &mut touched,
            |node, _| counts[node as usize] = counts[node as usize].saturating_add(1),
        );
    }
    let mut offsets = Vec::<u32>::with_capacity(node_count + 1);
    offsets.push(0);
    for count in counts {
        let next = offsets
            .last()
            .copied()
            .unwrap_or(0_u32)
            .checked_add(count)
            .ok_or_else(|| Error::from_reason("Street CCH target bucket index exceeds u32."))?;
        offsets.push(next);
    }
    let mut entries = vec![
        CchBucketEntry {
            target_index: 0,
            distance: cch::INF_WEIGHT,
        };
        *offsets.last().unwrap_or(&0) as usize
    ];
    let mut cursors = offsets[..node_count].to_vec();
    for (target_index, &target) in targets.iter().enumerate() {
        visit_cch_target_ancestors(
            cch,
            backward_weights,
            target,
            maximum_distance,
            &mut distances,
            &mut touched,
            |node, distance| {
                let cursor = &mut cursors[node as usize];
                entries[*cursor as usize] = CchBucketEntry {
                    target_index: target_index as u32,
                    distance,
                };
                *cursor += 1;
            },
        );
    }
    for node in 0..node_count {
        let start = offsets[node] as usize;
        let end = offsets[node + 1] as usize;
        entries[start..end].sort_unstable_by(|left, right| {
            left.distance
                .cmp(&right.distance)
                .then_with(|| left.target_index.cmp(&right.target_index))
        });
    }
    Ok(CchTargetBuckets {
        storage: CchBucketStorage::Owned { offsets, entries },
        maximum_distance,
    })
}

impl CchTargetBuckets {
    fn mapped(
        mmap: Arc<Mmap>,
        offsets_offset: usize,
        offsets_len: usize,
        entries_offset: usize,
        entries_len: usize,
        maximum_distance: u32,
    ) -> std::result::Result<Self, String> {
        for (label, offset, length, element_size, alignment) in [
            (
                "offsets",
                offsets_offset,
                offsets_len,
                size_of::<u32>(),
                align_of::<u32>(),
            ),
            (
                "entries",
                entries_offset,
                entries_len,
                size_of::<CchBucketEntry>(),
                align_of::<CchBucketEntry>(),
            ),
        ] {
            let bytes = length
                .checked_mul(element_size)
                .ok_or_else(|| format!("Persisted CCH bucket {label} length overflows."))?;
            let end = offset
                .checked_add(bytes)
                .ok_or_else(|| format!("Persisted CCH bucket {label} boundary overflows."))?;
            if end > mmap.len() || !(mmap[offset..].as_ptr() as usize).is_multiple_of(alignment) {
                return Err(format!(
                    "Persisted CCH bucket {label} exceeds or is misaligned within its file."
                ));
            }
        }
        Ok(Self {
            storage: CchBucketStorage::Mapped {
                mmap,
                offsets_offset,
                offsets_len,
                entries_offset,
                entries_len,
            },
            maximum_distance,
        })
    }

    fn offsets(&self) -> &[u32] {
        match &self.storage {
            CchBucketStorage::Owned { offsets, .. } => offsets,
            CchBucketStorage::Mapped {
                mmap,
                offsets_offset,
                offsets_len,
                ..
            } => unsafe {
                std::slice::from_raw_parts(
                    mmap.as_ptr().add(*offsets_offset).cast::<u32>(),
                    *offsets_len,
                )
            },
        }
    }

    fn entries(&self) -> &[CchBucketEntry] {
        match &self.storage {
            CchBucketStorage::Owned { entries, .. } => entries,
            CchBucketStorage::Mapped {
                mmap,
                entries_offset,
                entries_len,
                ..
            } => unsafe {
                std::slice::from_raw_parts(
                    mmap.as_ptr().add(*entries_offset).cast::<CchBucketEntry>(),
                    *entries_len,
                )
            },
        }
    }

    fn byte_length(&self) -> usize {
        std::mem::size_of_val(self.offsets()) + std::mem::size_of_val(self.entries())
    }

    fn validate(
        &self,
        node_count: usize,
        target_count: usize,
        expected_maximum_distance: u32,
    ) -> std::result::Result<(), String> {
        let offsets = self.offsets();
        let entries = self.entries();
        if Some(offsets.len()) != node_count.checked_add(1)
            || offsets.first() != Some(&0)
            || offsets.last().copied() != Some(entries.len() as u32)
            || offsets.windows(2).any(|pair| pair[0] > pair[1])
            || self.maximum_distance != expected_maximum_distance
        {
            return Err("Persisted street CCH target buckets are inconsistent.".to_owned());
        }
        if entries.iter().any(|entry| {
            entry.target_index as usize >= target_count
                || entry.distance > expected_maximum_distance
        }) {
            return Err("Persisted street CCH bucket entry is inconsistent.".to_owned());
        }
        Ok(())
    }
}

struct StreetCchIndex {
    // Drop the query before its boxed view, and the view before the mmap owner.
    // `PathQuery` is initialized lazily because its reusable scratch arrays are
    // node-count sized and generic path materialization is not used by every
    // routing request.
    path_query: Option<cch::PathQuery<'static>>,
    path_view: Option<Box<cch::bundle::CchView<'static>>>,
    structure: cch::CchBundle,
    metric: cch::MetricBundle,
    forward_query: DynamicCchQuery,
    reverse_query: DynamicCchQuery,
    origin_member_workspace: CchMemberWorkspace,
    destination_member_workspace: CchMemberWorkspace,
    origin_buckets: Option<CchTargetBuckets>,
    destination_buckets: Option<CchTargetBuckets>,
    bucket_build_ns: f64,
}

impl StreetCchIndex {
    fn fingerprint(&self) -> u64 {
        fn mix_slice(mut fingerprint: u64, values: &[u32]) -> u64 {
            fingerprint ^= values.len() as u64;
            fingerprint = fingerprint.wrapping_mul(0x100_0000_01b3);
            if values.is_empty() {
                return fingerprint;
            }
            // The access profile key already binds the exact street-store
            // identity. Sampling the immutable CCH bundle here detects an
            // accidentally paired structure/metric without reading the whole
            // national artifact on every process start.
            for sample in 0..32 {
                let index = sample * (values.len() - 1) / 31;
                let value = values[index];
                fingerprint ^= u64::from(value);
                fingerprint = fingerprint.wrapping_mul(0x100_0000_01b3);
            }
            fingerprint
        }

        let structure = self.structure.view();
        let metric = self.metric.view();
        let mut fingerprint = 0xcbf2_9ce4_8422_2325;
        for values in [
            structure.rank,
            structure.elimination_tree_parent,
            structure.up_first_out,
            structure.up_head,
            metric.forward,
            metric.backward,
        ] {
            fingerprint = mix_slice(fingerprint, values);
        }
        fingerprint
    }

    fn prepare_path_query(&mut self) {
        if self.path_query.is_some() {
            return;
        }
        // SAFETY: CchView contains only slices into `structure`'s immutable
        // mmap. Moving CchBundle does not move the mmap pages. The boxed view
        // has a stable address, and StreetCchIndex declares its fields so the
        // borrowing PathQuery drops first, followed by the boxed view, then the
        // mmap owner. Neither artifact can be replaced while this index lives.
        let view = unsafe {
            std::mem::transmute::<cch::bundle::CchView<'_>, cch::bundle::CchView<'static>>(
                self.structure.view(),
            )
        };
        self.path_view = Some(Box::new(view));
        let view_pointer = self
            .path_view
            .as_deref()
            .expect("street CCH path view was just installed")
            as *const cch::bundle::CchView<'static>;
        // SAFETY: `view_pointer` points into the Box stored in `path_view`, so
        // it remains stable until after `path_query` is dropped (see above).
        let static_view = unsafe { &*view_pointer };
        self.path_query = Some(cch::PathQuery::new(static_view));
    }
}

#[derive(Serialize, Deserialize)]
struct AccessProfile {
    key: String,
    anchor_lons: Vec<f64>,
    anchor_lats: Vec<f64>,
    anchor_member_offsets: Vec<u32>,
    anchor_member_indices: Vec<u32>,
    anchor_snaps: Vec<Vec<Snap>>,
    member_anchor_offsets: Vec<u32>,
    member_anchor_indices: Vec<u32>,
    member_lons: Vec<f64>,
    member_lats: Vec<f64>,
    member_origin_eligible: Vec<u8>,
    member_destination_eligible: Vec<u8>,
    member_stop_keys: Vec<u32>,
    member_station_keys: Vec<u32>,
    stop_lons: Vec<f64>,
    stop_lats: Vec<f64>,
    origin_station_member_offsets: Vec<u32>,
    origin_station_members: Vec<u32>,
    destination_station_member_offsets: Vec<u32>,
    destination_station_members: Vec<u32>,
    linked_access_offsets: Vec<u32>,
    linked_access: Vec<LinkedAccess>,
    reverse_linked_access_offsets: Vec<u32>,
    reverse_linked_access: Vec<LinkedAccess>,
    walking_speed_kph: f64,
    access_padding_factor: f64,
    access_overhead_seconds: f64,
    grid_keys: Vec<u64>,
    grid_offsets: Vec<u32>,
    grid_anchors: Vec<u32>,
    target_nodes: Vec<u32>,
    target_offsets: Vec<u32>,
    targets: Vec<Target>,
}

impl AccessProfile {
    fn byte_length(&self) -> usize {
        self.anchor_lons.capacity() * size_of::<f64>()
            + self.anchor_lats.capacity() * size_of::<f64>()
            + self.anchor_member_offsets.capacity() * size_of::<u32>()
            + self.anchor_member_indices.capacity() * size_of::<u32>()
            + self
                .anchor_snaps
                .iter()
                .map(|snaps| snaps.capacity() * size_of::<Snap>())
                .sum::<usize>()
            + self.member_anchor_offsets.capacity() * size_of::<u32>()
            + self.member_anchor_indices.capacity() * size_of::<u32>()
            + self.member_lons.capacity() * size_of::<f64>()
            + self.member_lats.capacity() * size_of::<f64>()
            + self.member_origin_eligible.capacity()
            + self.member_destination_eligible.capacity()
            + self.member_stop_keys.capacity() * size_of::<u32>()
            + self.member_station_keys.capacity() * size_of::<u32>()
            + self.stop_lons.capacity() * size_of::<f64>()
            + self.stop_lats.capacity() * size_of::<f64>()
            + self.origin_station_member_offsets.capacity() * size_of::<u32>()
            + self.origin_station_members.capacity() * size_of::<u32>()
            + self.destination_station_member_offsets.capacity() * size_of::<u32>()
            + self.destination_station_members.capacity() * size_of::<u32>()
            + self.linked_access_offsets.capacity() * size_of::<u32>()
            + self.linked_access.capacity() * size_of::<LinkedAccess>()
            + self.reverse_linked_access_offsets.capacity() * size_of::<u32>()
            + self.reverse_linked_access.capacity() * size_of::<LinkedAccess>()
            + self.grid_keys.capacity() * size_of::<u64>()
            + self.grid_offsets.capacity() * size_of::<u32>()
            + self.grid_anchors.capacity() * size_of::<u32>()
            + self.target_nodes.capacity() * size_of::<u32>()
            + self.target_offsets.capacity() * size_of::<u32>()
            + self.targets.capacity() * size_of::<Target>()
    }

    fn member_anchor_indices(&self, member: usize) -> &[u32] {
        let start = self.member_anchor_offsets[member] as usize;
        let end = self.member_anchor_offsets[member + 1] as usize;
        &self.member_anchor_indices[start..end]
    }

    fn member_has_snaps(&self, member: usize) -> bool {
        self.member_anchor_indices(member)
            .iter()
            .any(|anchor| !self.anchor_snaps[*anchor as usize].is_empty())
    }

    fn member_snap_frontier(&self, member: usize) -> Vec<Snap> {
        let mut frontier = self
            .member_anchor_indices(member)
            .iter()
            .flat_map(|anchor| self.anchor_snaps[*anchor as usize].iter().copied())
            .collect::<Vec<_>>();
        frontier.sort_unstable_by(|left, right| {
            left.node
                .cmp(&right.node)
                .then_with(|| left.distance_m.total_cmp(&right.distance_m))
        });
        frontier.dedup_by_key(|snap| snap.node);
        frontier.sort_by(|left, right| {
            left.distance_m
                .total_cmp(&right.distance_m)
                .then_with(|| left.node.cmp(&right.node))
        });
        frontier
    }

    fn snap_reference_count(&self) -> usize {
        (0..self.member_lons.len())
            .map(|member| {
                self.member_anchor_indices(member)
                    .iter()
                    .map(|anchor| self.anchor_snaps[*anchor as usize].len())
                    .sum::<usize>()
            })
            .sum()
    }

    fn anchors_in_cell(&self, latitude_cell: i32, longitude_cell: i32) -> &[u32] {
        let key = access_cell_key(latitude_cell, longitude_cell);
        let Ok(offset) = self.grid_keys.binary_search(&key) else {
            return &[];
        };
        let start = self.grid_offsets[offset] as usize;
        let end = self.grid_offsets[offset + 1] as usize;
        &self.grid_anchors[start..end]
    }

    fn targets_for_node(&self, node: u32) -> &[Target] {
        let Ok(offset) = self.target_nodes.binary_search(&node) else {
            return &[];
        };
        let start = self.target_offsets[offset] as usize;
        let end = self.target_offsets[offset + 1] as usize;
        &self.targets[start..end]
    }

    fn station_members(&self, station: u32, origin_role: bool) -> &[u32] {
        let station = station as usize;
        let (offsets, members) = if origin_role {
            (
                &self.origin_station_member_offsets,
                &self.origin_station_members,
            )
        } else {
            (
                &self.destination_station_member_offsets,
                &self.destination_station_members,
            )
        };
        if station + 1 >= offsets.len() {
            return &[];
        }
        let start = offsets[station] as usize;
        let end = offsets[station + 1] as usize;
        &members[start..end]
    }

    fn linked_from_stop(&self, stop: u32, origin_role: bool) -> &[LinkedAccess] {
        let (offsets, links) = if origin_role {
            (&self.linked_access_offsets, &self.linked_access)
        } else {
            (
                &self.reverse_linked_access_offsets,
                &self.reverse_linked_access,
            )
        };
        let stop = stop as usize;
        if stop + 1 >= offsets.len() {
            return &[];
        }
        &links[offsets[stop] as usize..offsets[stop + 1] as usize]
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
struct LinkedAccess {
    from_stop_key: u32,
    to_stop_key: u32,
    target_station_key: u32,
    duration_seconds: u32,
    path_distance_m: f64,
    street_path_verified: bool,
}

struct AccessProfileSnapshotLayout {
    profile_start: usize,
    profile_end: usize,
    origin_offsets_start: usize,
    origin_entries_start: usize,
    destination_offsets_start: usize,
    destination_entries_start: usize,
    total_bytes: usize,
}

fn aligned_snapshot_offset(offset: usize, alignment: usize) -> Option<usize> {
    offset
        .checked_add(alignment - 1)
        .map(|value| value / alignment * alignment)
}

fn access_profile_snapshot_layout(
    profile_bytes: usize,
    origin_offsets: usize,
    origin_entries: usize,
    destination_offsets: usize,
    destination_entries: usize,
) -> Option<AccessProfileSnapshotLayout> {
    let profile_start = ACCESS_PROFILE_SNAPSHOT_HEADER_BYTES;
    let profile_end = profile_start.checked_add(profile_bytes)?;
    let origin_offsets_start = aligned_snapshot_offset(profile_end, align_of::<u32>())?;
    let origin_entries_start = aligned_snapshot_offset(
        origin_offsets_start.checked_add(origin_offsets.checked_mul(size_of::<u32>())?)?,
        align_of::<CchBucketEntry>(),
    )?;
    let destination_offsets_start = aligned_snapshot_offset(
        origin_entries_start
            .checked_add(origin_entries.checked_mul(size_of::<CchBucketEntry>())?)?,
        align_of::<u32>(),
    )?;
    let destination_entries_start = aligned_snapshot_offset(
        destination_offsets_start
            .checked_add(destination_offsets.checked_mul(size_of::<u32>())?)?,
        align_of::<CchBucketEntry>(),
    )?;
    let total_bytes = destination_entries_start
        .checked_add(destination_entries.checked_mul(size_of::<CchBucketEntry>())?)?;
    Some(AccessProfileSnapshotLayout {
        profile_start,
        profile_end,
        origin_offsets_start,
        origin_entries_start,
        destination_offsets_start,
        destination_entries_start,
        total_bytes,
    })
}

fn snapshot_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn snapshot_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        bytes.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

fn snapshot_slice_bytes<T>(values: &[T]) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(values))
    }
}

fn write_snapshot_padding<W: Write>(
    writer: &mut W,
    position: &mut usize,
    target: usize,
) -> std::io::Result<()> {
    const ZEROES: [u8; 8] = [0; 8];
    while *position < target {
        let count = (target - *position).min(ZEROES.len());
        writer.write_all(&ZEROES[..count])?;
        *position += count;
    }
    Ok(())
}

fn validate_profile_csr(
    offsets: &[u32],
    rows: usize,
    values: usize,
    label: &str,
) -> std::result::Result<(), String> {
    if offsets.len() != rows + 1
        || offsets.first() != Some(&0)
        || offsets.last().copied() != Some(values as u32)
        || offsets.windows(2).any(|pair| pair[0] > pair[1])
    {
        return Err(format!("Persisted access profile {label} CSR is invalid."));
    }
    Ok(())
}

impl AccessProfile {
    fn validate(&self, snapshot: &Snapshot, expected_key: &str) -> std::result::Result<(), String> {
        let anchor_count = self.anchor_lons.len();
        let member_count = self.member_lons.len();
        let stop_count = self.stop_lons.len();
        if self.key != expected_key || self.key.trim().is_empty() {
            return Err("Persisted access profile identity does not match the request.".to_owned());
        }
        if self.anchor_lats.len() != anchor_count
            || self.anchor_snaps.len() != anchor_count
            || self.member_lats.len() != member_count
            || self.member_origin_eligible.len() != member_count
            || self.member_destination_eligible.len() != member_count
            || self.member_stop_keys.len() != member_count
            || self.member_station_keys.len() != member_count
            || self.stop_lats.len() != stop_count
            || !self.walking_speed_kph.is_finite()
            || self.walking_speed_kph <= 0.0
            || !self.access_padding_factor.is_finite()
            || self.access_padding_factor <= 0.0
            || !self.access_overhead_seconds.is_finite()
            || self.access_overhead_seconds < 0.0
        {
            return Err("Persisted access profile dimensions or policy are invalid.".to_owned());
        }
        validate_profile_csr(
            &self.anchor_member_offsets,
            anchor_count,
            self.anchor_member_indices.len(),
            "anchor-member",
        )?;
        validate_profile_csr(
            &self.member_anchor_offsets,
            member_count,
            self.member_anchor_indices.len(),
            "member-anchor",
        )?;
        validate_profile_csr(
            &self.origin_station_member_offsets,
            stop_count,
            self.origin_station_members.len(),
            "origin-station-member",
        )?;
        validate_profile_csr(
            &self.destination_station_member_offsets,
            stop_count,
            self.destination_station_members.len(),
            "destination-station-member",
        )?;
        validate_profile_csr(
            &self.linked_access_offsets,
            stop_count,
            self.linked_access.len(),
            "linked-access",
        )?;
        validate_profile_csr(
            &self.reverse_linked_access_offsets,
            stop_count,
            self.reverse_linked_access.len(),
            "reverse-linked-access",
        )?;
        validate_profile_csr(
            &self.grid_offsets,
            self.grid_keys.len(),
            self.grid_anchors.len(),
            "access-grid",
        )?;
        validate_profile_csr(
            &self.target_offsets,
            self.target_nodes.len(),
            self.targets.len(),
            "street-target",
        )?;
        if self
            .anchor_member_indices
            .iter()
            .any(|value| *value as usize >= member_count)
            || self
                .member_anchor_indices
                .iter()
                .any(|value| *value as usize >= anchor_count)
            || self
                .member_stop_keys
                .iter()
                .any(|value| *value as usize >= stop_count)
            || self
                .member_station_keys
                .iter()
                .any(|value| *value != NO_PROFILE_KEY && *value as usize >= stop_count)
            || self
                .origin_station_members
                .iter()
                .any(|value| *value as usize >= member_count)
            || self
                .destination_station_members
                .iter()
                .any(|value| *value as usize >= member_count)
            || self
                .grid_anchors
                .iter()
                .any(|value| *value as usize >= anchor_count)
            || self
                .targets
                .iter()
                .any(|target| target.member as usize >= member_count)
            || self
                .target_nodes
                .iter()
                .any(|node| *node as usize >= snapshot.header.node_count)
        {
            return Err("Persisted access profile contains an out-of-range index.".to_owned());
        }
        if self.anchor_snaps.iter().flatten().any(|snap| {
            snap.node as usize >= snapshot.header.node_count
                || !snap.distance_m.is_finite()
                || snap.distance_m < 0.0
        }) || self
            .targets
            .iter()
            .any(|target| !target.snap_distance_m.is_finite() || target.snap_distance_m < 0.0)
            || self
                .linked_access
                .iter()
                .chain(&self.reverse_linked_access)
                .any(|link| {
                    link.from_stop_key as usize >= stop_count
                        || link.to_stop_key as usize >= stop_count
                        || link.target_station_key as usize >= stop_count
                        || !link.path_distance_m.is_finite()
                })
            || self
                .anchor_lons
                .iter()
                .chain(self.anchor_lats.iter())
                .chain(self.member_lons.iter())
                .chain(self.member_lats.iter())
                .chain(self.stop_lons.iter())
                .chain(self.stop_lats.iter())
                .any(|value| !value.is_finite())
        {
            return Err("Persisted access profile contains an invalid value.".to_owned());
        }
        if self.grid_keys.windows(2).any(|pair| pair[0] >= pair[1])
            || self.target_nodes.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(
                "Persisted access profile lookup keys are not strictly ordered.".to_owned(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Default)]
struct AccessLabel {
    stop_key: u32,
    member: u32,
    path_member: u32,
    distance_m: f64,
    access_seconds: u32,
    candidate_kind: u32,
    link_from_stop_key: u32,
    link_to_stop_key: u32,
    link_duration: u32,
    link_path_distance_m: f64,
    link_street_verified: bool,
}

struct ReducedAccessFrontier {
    member_indices: Vec<u32>,
    path_member_indices: Vec<u32>,
    distances_m: Vec<f64>,
    access_seconds: Vec<u32>,
    candidate_kinds: Vec<u32>,
    link_from_stop_keys: Vec<u32>,
    link_to_stop_keys: Vec<u32>,
    link_durations: Vec<u32>,
    link_path_distances_m: Vec<f64>,
    link_street_verified: Vec<u32>,
    linked_stations: u32,
    reduction_ns: f64,
}

impl ReducedAccessFrontier {
    fn from_labels(mut labels: Vec<AccessLabel>, linked_stations: usize) -> Self {
        labels.sort_by(|left, right| {
            left.distance_m
                .total_cmp(&right.distance_m)
                .then_with(|| left.stop_key.cmp(&right.stop_key))
                .then_with(|| left.path_member.cmp(&right.path_member))
        });
        let mut result = Self {
            member_indices: Vec::with_capacity(labels.len()),
            path_member_indices: Vec::with_capacity(labels.len()),
            distances_m: Vec::with_capacity(labels.len()),
            access_seconds: Vec::with_capacity(labels.len()),
            candidate_kinds: Vec::with_capacity(labels.len()),
            link_from_stop_keys: Vec::with_capacity(labels.len()),
            link_to_stop_keys: Vec::with_capacity(labels.len()),
            link_durations: Vec::with_capacity(labels.len()),
            link_path_distances_m: Vec::with_capacity(labels.len()),
            link_street_verified: Vec::with_capacity(labels.len()),
            linked_stations: linked_stations as u32,
            reduction_ns: 0.0,
        };
        for label in labels {
            result.member_indices.push(label.member);
            result.path_member_indices.push(label.path_member);
            result.distances_m.push(label.distance_m);
            result.access_seconds.push(label.access_seconds);
            result.candidate_kinds.push(label.candidate_kind);
            result.link_from_stop_keys.push(label.link_from_stop_key);
            result.link_to_stop_keys.push(label.link_to_stop_key);
            result.link_durations.push(label.link_duration);
            result
                .link_path_distances_m
                .push(label.link_path_distance_m);
            result
                .link_street_verified
                .push(u32::from(label.link_street_verified));
        }
        result
    }
}

#[derive(Clone, Copy, Default)]
struct DirectSource {
    member: u32,
    distance_m: f64,
    access_seconds: u32,
    exact: bool,
}

#[derive(Clone, Copy, Default)]
struct LinkedSource {
    target_station_key: u32,
    path_member: u32,
    distance_m: f64,
    access_seconds: u32,
    link: LinkedAccess,
}

struct AccessReductionWorkspace {
    generation: u32,
    source_generation: Vec<u32>,
    sources: Vec<DirectSource>,
    source_touched: Vec<u32>,
    direct_station_generation: Vec<u32>,
    direct_stations: Vec<DirectSource>,
    direct_station_touched: Vec<u32>,
    linked_station_generation: Vec<u32>,
    linked_stations: Vec<LinkedSource>,
    linked_station_touched: Vec<u32>,
    selected_generation: Vec<u32>,
    selected: Vec<AccessLabel>,
    selected_touched: Vec<u32>,
}

impl AccessReductionWorkspace {
    fn new() -> Self {
        Self {
            generation: 0,
            source_generation: Vec::new(),
            sources: Vec::new(),
            source_touched: Vec::new(),
            direct_station_generation: Vec::new(),
            direct_stations: Vec::new(),
            direct_station_touched: Vec::new(),
            linked_station_generation: Vec::new(),
            linked_stations: Vec::new(),
            linked_station_touched: Vec::new(),
            selected_generation: Vec::new(),
            selected: Vec::new(),
            selected_touched: Vec::new(),
        }
    }

    fn begin(&mut self, member_count: usize, stop_count: usize) -> u32 {
        if self.source_generation.len() != member_count {
            self.source_generation = vec![0; member_count];
            self.sources = vec![DirectSource::default(); member_count];
        }
        if self.selected_generation.len() != stop_count {
            self.direct_station_generation = vec![0; stop_count];
            self.direct_stations = vec![DirectSource::default(); stop_count];
            self.linked_station_generation = vec![0; stop_count];
            self.linked_stations = vec![LinkedSource::default(); stop_count];
            self.selected_generation = vec![0; stop_count];
            self.selected = vec![AccessLabel::default(); stop_count];
        }
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.source_generation.fill(0);
            self.direct_station_generation.fill(0);
            self.linked_station_generation.fill(0);
            self.selected_generation.fill(0);
            self.generation = 1;
        }
        self.source_touched.clear();
        self.direct_station_touched.clear();
        self.linked_station_touched.clear();
        self.selected_touched.clear();
        self.generation
    }

    fn retain_source(&mut self, generation: u32, source: DirectSource) {
        let member = source.member as usize;
        if self.source_generation[member] != generation {
            self.source_generation[member] = generation;
            self.sources[member] = source;
            self.source_touched.push(source.member);
        } else if direct_source_better(&source, &self.sources[member]) {
            self.sources[member] = source;
        }
    }

    fn retain_direct_station(&mut self, generation: u32, station: u32, source: DirectSource) {
        let station_index = station as usize;
        if self.direct_station_generation[station_index] != generation {
            self.direct_station_generation[station_index] = generation;
            self.direct_stations[station_index] = source;
            self.direct_station_touched.push(station);
        } else if direct_source_better(&source, &self.direct_stations[station_index]) {
            self.direct_stations[station_index] = source;
        }
    }

    fn retain_linked_station(&mut self, generation: u32, source: LinkedSource) {
        let station = source.target_station_key as usize;
        if self.linked_station_generation[station] != generation {
            self.linked_station_generation[station] = generation;
            self.linked_stations[station] = source;
            self.linked_station_touched.push(source.target_station_key);
        } else if linked_source_better(&source, &self.linked_stations[station]) {
            self.linked_stations[station] = source;
        }
    }

    fn retain_selected(&mut self, generation: u32, candidate: AccessLabel) {
        let stop = candidate.stop_key as usize;
        if self.selected_generation[stop] != generation {
            self.selected_generation[stop] = generation;
            self.selected[stop] = candidate;
            self.selected_touched.push(candidate.stop_key);
        } else if access_label_better(&candidate, &self.selected[stop]) {
            self.selected[stop] = candidate;
        }
    }
}

fn candidate_kind_rank(kind: u32) -> u32 {
    match kind {
        2 => 0, // exact coordinate identity
        0 => 1, // direct native street frontier
        _ => 2, // transfer-linked station access
    }
}

fn access_label_better(candidate: &AccessLabel, current: &AccessLabel) -> bool {
    candidate.access_seconds < current.access_seconds
        || (candidate.access_seconds == current.access_seconds
            && (candidate.distance_m < current.distance_m
                || (candidate.distance_m == current.distance_m
                    && (candidate_kind_rank(candidate.candidate_kind)
                        < candidate_kind_rank(current.candidate_kind)
                        || (candidate.candidate_kind == current.candidate_kind
                            && candidate.path_member < current.path_member)))))
}

#[derive(Clone, Copy)]
struct AccessTiming {
    walking_speed_kph: f64,
    access_padding_factor: f64,
    access_overhead_seconds: f64,
}

#[derive(Clone, Copy)]
struct AccessEndpoint {
    longitude: f64,
    latitude: f64,
    maximum_walk_m: f64,
    origin_role: bool,
}

impl AccessTiming {
    fn resolve(
        profile: &AccessProfile,
        walking_speed_kph: Option<f64>,
        access_padding_factor: Option<f64>,
        access_overhead_seconds: Option<f64>,
    ) -> napi::Result<Self> {
        let timing = Self {
            walking_speed_kph: walking_speed_kph.unwrap_or(profile.walking_speed_kph),
            access_padding_factor: access_padding_factor.unwrap_or(profile.access_padding_factor),
            access_overhead_seconds: access_overhead_seconds
                .unwrap_or(profile.access_overhead_seconds),
        };
        if !timing.walking_speed_kph.is_finite()
            || timing.walking_speed_kph <= 0.0
            || !timing.access_padding_factor.is_finite()
            || timing.access_padding_factor <= 0.0
            || !timing.access_overhead_seconds.is_finite()
            || timing.access_overhead_seconds < 0.0
        {
            return Err(Error::from_reason(
                "Rust query-scoped access timing parameters are inconsistent.",
            ));
        }
        Ok(timing)
    }
}

fn access_walk_seconds(timing: AccessTiming, distance_m: f64, exact: bool) -> u32 {
    if exact {
        return 0;
    }
    let seconds = (distance_m.max(0.0) / 1000.0 / timing.walking_speed_kph
        * 3600.0
        * timing.access_padding_factor
        + timing.access_overhead_seconds)
        .ceil();
    seconds.clamp(0.0, u32::MAX as f64) as u32
}

fn member_is_exact(
    profile: &AccessProfile,
    member: usize,
    longitude: f64,
    latitude: f64,
    distance_m: f64,
) -> bool {
    distance_m <= f64::EPSILON
        && profile.member_lons[member] == longitude
        && profile.member_lats[member] == latitude
}

fn direct_source_better(candidate: &DirectSource, current: &DirectSource) -> bool {
    candidate.access_seconds < current.access_seconds
        || (candidate.access_seconds == current.access_seconds
            && (candidate.distance_m < current.distance_m
                || (candidate.distance_m == current.distance_m
                    && (candidate.exact && !current.exact
                        || (candidate.exact == current.exact
                            && candidate.member < current.member)))))
}

fn linked_source_better(candidate: &LinkedSource, current: &LinkedSource) -> bool {
    candidate.access_seconds < current.access_seconds
        || (candidate.access_seconds == current.access_seconds
            && (candidate.distance_m < current.distance_m
                || (candidate.distance_m == current.distance_m
                    && (candidate.target_station_key < current.target_station_key
                        || (candidate.target_station_key == current.target_station_key
                            && candidate.path_member < current.path_member)))))
}

fn reduce_access_frontier(
    profile: &AccessProfile,
    timing: AccessTiming,
    frontier: &FrontierSearch,
    workspace: &mut AccessReductionWorkspace,
    endpoint: AccessEndpoint,
) -> ReducedAccessFrontier {
    let AccessEndpoint {
        longitude,
        latitude,
        maximum_walk_m,
        origin_role,
    } = endpoint;
    let reduction_started = Instant::now();
    let generation = workspace.begin(profile.member_lons.len(), profile.stop_lons.len());

    for (&member, &distance_m) in frontier
        .member_indices
        .iter()
        .zip(frontier.distances_m.iter())
    {
        let member_index = member as usize;
        let exact = member_is_exact(profile, member_index, longitude, latitude, distance_m);
        let source = DirectSource {
            member,
            distance_m,
            access_seconds: access_walk_seconds(timing, distance_m, exact),
            exact,
        };
        workspace.retain_source(generation, source);
    }
    for member in profile.exact_members_at_coordinate(longitude, latitude, origin_role) {
        workspace.retain_source(
            generation,
            DirectSource {
                member,
                distance_m: 0.0,
                access_seconds: 0,
                exact: true,
            },
        );
    }
    workspace.source_touched.sort_unstable();
    let raw_sources = workspace.source_touched.clone();
    for &source_member in &raw_sources {
        let source = workspace.sources[source_member as usize];
        let member = source.member;
        let member_index = member as usize;
        let station = profile.member_station_keys[member_index];
        if station == NO_PROFILE_KEY {
            let stop_key = profile.member_stop_keys[member_index];
            workspace.retain_selected(
                generation,
                AccessLabel {
                    stop_key,
                    member,
                    path_member: member,
                    distance_m: source.distance_m,
                    access_seconds: source.access_seconds,
                    candidate_kind: if source.exact { 2 } else { 0 },
                    link_from_stop_key: NO_PROFILE_KEY,
                    link_to_stop_key: NO_PROFILE_KEY,
                    link_duration: 0,
                    link_path_distance_m: -1.0,
                    link_street_verified: false,
                },
            );
            continue;
        }
        workspace.retain_direct_station(generation, station, source);
    }

    let direct_stations = workspace.direct_station_touched.clone();
    for station in direct_stations {
        let source = workspace.direct_stations[station as usize];
        let members = profile.station_members(station, origin_role);
        for &member in members {
            workspace.retain_selected(
                generation,
                AccessLabel {
                    stop_key: profile.member_stop_keys[member as usize],
                    member,
                    path_member: source.member,
                    distance_m: source.distance_m,
                    access_seconds: source.access_seconds,
                    candidate_kind: if source.exact { 2 } else { 0 },
                    link_from_stop_key: NO_PROFILE_KEY,
                    link_to_stop_key: NO_PROFILE_KEY,
                    link_duration: 0,
                    link_path_distance_m: -1.0,
                    link_street_verified: false,
                },
            );
        }
    }

    for source_member in raw_sources {
        let source = workspace.sources[source_member as usize];
        let member = source.member as usize;
        let source_stop_key = profile.member_stop_keys[member];
        let source_station_key = profile.member_station_keys[member];
        for source_key in [source_stop_key, source_station_key] {
            if source_key == NO_PROFILE_KEY {
                continue;
            }
            for &link in profile.linked_from_stop(source_key, origin_role) {
                if link.target_station_key == source_station_key {
                    continue;
                }
                let transfer_distance_m =
                    if link.path_distance_m.is_finite() && link.path_distance_m >= 0.0 {
                        link.path_distance_m
                    } else {
                        haversine_m(
                            profile.stop_lons[source_stop_key as usize],
                            profile.stop_lats[source_stop_key as usize],
                            profile.stop_lons[link.to_stop_key as usize],
                            profile.stop_lats[link.to_stop_key as usize],
                        )
                    };
                let distance_m = source.distance_m + transfer_distance_m;
                if distance_m > maximum_walk_m + 1e-6 {
                    continue;
                }
                let candidate = LinkedSource {
                    target_station_key: link.target_station_key,
                    path_member: source.member,
                    distance_m,
                    access_seconds: source.access_seconds.saturating_add(link.duration_seconds),
                    link,
                };
                workspace.retain_linked_station(generation, candidate);
            }
            if source_station_key == source_stop_key {
                break;
            }
        }
    }
    let mut linked = workspace
        .linked_station_touched
        .iter()
        .map(|station| workspace.linked_stations[*station as usize])
        .collect::<Vec<_>>();
    linked.sort_by(|left, right| {
        left.access_seconds
            .cmp(&right.access_seconds)
            .then_with(|| left.distance_m.total_cmp(&right.distance_m))
            .then_with(|| left.target_station_key.cmp(&right.target_station_key))
            .then_with(|| left.path_member.cmp(&right.path_member))
    });
    let linked_station_count = linked.len();
    for source in linked {
        for &member in profile.station_members(source.target_station_key, origin_role) {
            workspace.retain_selected(
                generation,
                AccessLabel {
                    stop_key: profile.member_stop_keys[member as usize],
                    member,
                    path_member: source.path_member,
                    distance_m: source.distance_m,
                    access_seconds: source.access_seconds,
                    candidate_kind: 1,
                    link_from_stop_key: source.link.from_stop_key,
                    link_to_stop_key: source.link.to_stop_key,
                    link_duration: source.link.duration_seconds,
                    link_path_distance_m: source.link.path_distance_m,
                    link_street_verified: source.link.street_path_verified,
                },
            );
        }
    }

    let labels = workspace
        .selected_touched
        .iter()
        .map(|stop| workspace.selected[*stop as usize])
        .collect();
    let mut reduced = ReducedAccessFrontier::from_labels(labels, linked_station_count);
    reduced.reduction_ns = reduction_started.elapsed().as_nanos() as f64;
    reduced
}

#[derive(Clone)]
struct FrontierSearch {
    member_indices: Vec<u32>,
    distances_m: Vec<f64>,
    terminals: Vec<u32>,
    source_terminals: Vec<u32>,
    source_snaps: Vec<Snap>,
    terminal_attachment: Option<Arc<TerminalAttachment>>,
    predecessors: Vec<(u32, u32, u32)>,
    reverse_direction: bool,
    source_longitude: f64,
    source_latitude: f64,
    maximum_distance_m: f64,
    cch_accelerated: bool,
    settled_nodes: u32,
    relaxed_edges: u32,
}

impl FrontierSearch {
    fn byte_length(&self) -> usize {
        self.member_indices.capacity() * size_of::<u32>()
            + self.distances_m.capacity() * size_of::<f64>()
            + self.terminals.capacity() * size_of::<u32>()
            + self.source_terminals.capacity() * size_of::<u32>()
            + self.source_snaps.capacity() * size_of::<Snap>()
            + self.predecessors.capacity() * size_of::<(u32, u32, u32)>()
            + self
                .terminal_attachment
                .as_ref()
                .map_or(0, |a| a.byte_length())
    }

    fn predecessor(&self, node: u32) -> napi::Result<(u32, u32)> {
        let predecessor_offset = self
            .predecessors
            .binary_search_by_key(&node, |(candidate, _, _)| *candidate)
            .map_err(|_| {
                Error::from_reason(
                    "Rust shared predecessor forest is incomplete for this stop label.",
                )
            })?;
        let (_, predecessor, first_node) = self.predecessors[predecessor_offset];
        Ok((predecessor, first_node))
    }

    fn path_for_member(&self, snapshot: &Snapshot, member: u32) -> napi::Result<Vec<u32>> {
        let member_offset = self
            .member_indices
            .iter()
            .position(|candidate| *candidate == member)
            .ok_or_else(|| {
                Error::from_reason("Rust street path is unavailable for this stop label.")
            })?;
        let edge_offsets = snapshot.u32_array("edgeOffsets")?;
        let edge_targets = snapshot.u32_array("edgeTargets")?;
        let mut vertices = Vec::new();
        let mut cursor = self.terminals[member_offset];
        while cursor != NO_PREDECESSOR && vertices.len() < 100_000 {
            vertices.push(cursor);
            cursor = self.predecessor(cursor)?.0;
        }
        if vertices.len() >= 100_000 {
            return Err(Error::from_reason(
                "Rust shared predecessor forest exceeds its path bound.",
            ));
        }
        if vertices.is_empty() {
            return Ok(Vec::new());
        }
        if !self.reverse_direction {
            vertices.reverse();
            let mut path = vec![vertices[0]];
            for &target in vertices.iter().skip(1) {
                let (source, first_node) = self.predecessor(target)?;
                append_contracted_point_segment(
                    &mut path,
                    source,
                    target,
                    first_node,
                    edge_offsets,
                    edge_targets,
                )?;
            }
            return Ok(path);
        }
        let mut path = vec![vertices[0]];
        for &source in vertices.iter().take(vertices.len().saturating_sub(1)) {
            let (target, first_node) = self.predecessor(source)?;
            append_contracted_point_segment(
                &mut path,
                source,
                target,
                first_node,
                edge_offsets,
                edge_targets,
            )?;
        }
        Ok(path)
    }
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
struct EndpointCacheKey {
    longitude_bits: u64,
    latitude_bits: u64,
    maximum_distance_bits: u64,
}

impl EndpointCacheKey {
    fn new(longitude: f64, latitude: f64, maximum_distance_m: f64) -> Self {
        Self {
            longitude_bits: longitude.to_bits(),
            latitude_bits: latitude.to_bits(),
            maximum_distance_bits: maximum_distance_m.to_bits(),
        }
    }
}

#[napi(object)]
pub struct AccessProfileInput {
    pub profile_key: String,
    pub anchor_lons: Vec<f64>,
    pub anchor_lats: Vec<f64>,
    pub anchor_member_offsets: Vec<u32>,
    pub anchor_member_indices: Vec<u32>,
    pub member_lons: Vec<f64>,
    pub member_lats: Vec<f64>,
    pub member_origin_eligible: Vec<u32>,
    pub member_destination_eligible: Vec<u32>,
    pub member_origin_expansion_eligible: Option<Vec<u32>>,
    pub member_destination_expansion_eligible: Option<Vec<u32>>,
    pub member_stop_keys: Option<Vec<u32>>,
    pub member_station_keys: Option<Vec<u32>>,
    pub stop_lons: Option<Vec<f64>>,
    pub stop_lats: Option<Vec<f64>>,
    pub transfer_from_stop_keys: Option<Vec<u32>>,
    pub transfer_to_stop_keys: Option<Vec<u32>>,
    pub transfer_to_station_keys: Option<Vec<u32>>,
    pub transfer_min_durations: Option<Vec<u32>>,
    pub transfer_osm_certified: Option<Vec<u32>>,
    pub transfer_path_distances_m: Option<Vec<f64>>,
    pub walking_speed_kph: Option<f64>,
    pub access_padding_factor: Option<f64>,
    pub access_overhead_seconds: Option<f64>,
    pub prepare_cch_buckets: Option<bool>,
}

#[napi(object)]
pub struct EndpointRouteInput {
    pub origin_lon: f64,
    pub origin_lat: f64,
    pub destination_lon: f64,
    pub destination_lat: f64,
    pub maximum_walk_m: f64,
    pub walking_speed_kph: Option<f64>,
    pub access_padding_factor: Option<f64>,
    pub access_overhead_seconds: Option<f64>,
    pub disable_cache: Option<bool>,
}

#[napi(object)]
pub struct EndpointRouteResult {
    pub query_token: u32,
    pub cache_hit: bool,
    pub origin_cache_hit: bool,
    pub destination_cache_hit: bool,
    pub origin_member_indices: Vec<u32>,
    pub origin_path_member_indices: Vec<u32>,
    pub origin_distances_m: Vec<f64>,
    pub origin_access_seconds: Vec<u32>,
    pub origin_candidate_kinds: Vec<u32>,
    pub origin_link_from_stop_keys: Vec<u32>,
    pub origin_link_to_stop_keys: Vec<u32>,
    pub origin_link_durations: Vec<u32>,
    pub origin_link_path_distances_m: Vec<f64>,
    pub origin_link_street_verified: Vec<u32>,
    pub origin_access_reduction_ns: f64,
    pub destination_member_indices: Vec<u32>,
    pub destination_path_member_indices: Vec<u32>,
    pub destination_distances_m: Vec<f64>,
    pub destination_access_seconds: Vec<u32>,
    pub destination_candidate_kinds: Vec<u32>,
    pub destination_link_from_stop_keys: Vec<u32>,
    pub destination_link_to_stop_keys: Vec<u32>,
    pub destination_link_durations: Vec<u32>,
    pub destination_link_path_distances_m: Vec<f64>,
    pub destination_link_street_verified: Vec<u32>,
    pub destination_access_reduction_ns: f64,
    pub query_ns: f64,
    pub access_reduction_ns: f64,
    pub snap_ns: f64,
    pub origin_search_ns: f64,
    pub destination_search_ns: f64,
    pub origin_settled_nodes: u32,
    pub destination_settled_nodes: u32,
    pub origin_relaxed_edges: u32,
    pub destination_relaxed_edges: u32,
    pub origin_raw_candidates: u32,
    pub destination_raw_candidates: u32,
    pub origin_linked_stations: u32,
    pub destination_linked_stations: u32,
    pub origin_cch_accelerated: bool,
    pub destination_cch_accelerated: bool,
}

#[napi(object)]
pub struct CoordinateTimetableInput {
    pub origin_lon: f64,
    pub origin_lat: f64,
    pub destination_lon: f64,
    pub destination_lat: f64,
    pub maximum_walk_m: f64,
    pub walking_speed_kph: Option<f64>,
    pub access_padding_factor: Option<f64>,
    pub access_overhead_seconds: Option<f64>,
    pub member_timetable_stops: Uint32Array,
    pub departure: f64,
    pub horizon: f64,
    pub arrive_by_earliest: Option<f64>,
    pub arrive_by_deadline: Option<f64>,
    pub allow_pre_ride_transfers: bool,
    pub retain_full_frontier: bool,
    pub enable_direct_walk_dominance: bool,
    pub disable_cache: Option<bool>,
    pub maximum_boardings: Option<u32>,
}

#[napi(object)]
pub struct CoordinateTimetableMatrixInput {
    pub origin_coordinates: Vec<f64>,
    pub destination_coordinates: Vec<f64>,
    pub maximum_walk_m: f64,
    pub walking_speed_kph: Option<f64>,
    pub access_padding_factor: Option<f64>,
    pub access_overhead_seconds: Option<f64>,
    pub member_timetable_stops: Uint32Array,
    pub departure: f64,
    pub horizon: f64,
    pub arrive_by: bool,
    pub maximum_boardings: Option<u32>,
    pub disable_cache: Option<bool>,
}

#[napi(object)]
pub struct CoordinateTimetableMatrixResult {
    pub timetable: TimetableMatrixQueryResult,
    pub access_ns: f64,
    pub query_ns: f64,
}

#[napi(object)]
pub struct CoordinateTimetableResult {
    pub endpoints: Option<EndpointRouteResult>,
    pub compact_endpoints: Option<CompactEndpointRouteResult>,
    pub timetable: Option<TimetableQueryResult>,
    pub arrive_by: Option<TimetableArriveByQueryResult>,
    pub direct_walk_cch_checked: bool,
    pub direct_walk_distance_m: Option<f64>,
    pub direct_walk_query_ns: f64,
    pub direct_walk_path_checked: bool,
    pub direct_walk_path: Option<StreetPathResult>,
    pub direct_walk_path_query_ns: f64,
    pub direct_walk_access_dominates: bool,
    pub compact_frontier: bool,
    pub origin_candidate_count: u32,
    pub destination_candidate_count: u32,
    pub minimum_origin_access_seconds: Option<u32>,
    pub minimum_destination_access_seconds: Option<u32>,
    pub query_ns: f64,
    pub access_ns: f64,
    pub timetable_ns: f64,
    pub arrive_by_ns: f64,
    pub forward_timetable_ns: f64,
}

/// Fused arbitrary-coordinate origin access plus exact one-to-many timetable
/// search over the same resident timetable image used by scalar point routing.
#[napi(object)]
pub struct CoordinateTimetableManyInput {
    pub origin_lon: f64,
    pub origin_lat: f64,
    pub maximum_walk_m: f64,
    pub walking_speed_kph: Option<f64>,
    pub access_padding_factor: Option<f64>,
    pub access_overhead_seconds: Option<f64>,
    pub member_timetable_stops: Uint32Array,
    pub target_timetable_stops: Uint32Array,
    pub excluded_trips: Uint32Array,
    pub departure: f64,
    pub horizon: f64,
    pub allow_pre_ride_transfers: bool,
    pub disable_cache: Option<bool>,
    pub maximum_boardings: Option<u32>,
}

#[napi(object)]
pub struct CoordinateTimetableManyResult {
    pub access: EndpointRoleResult,
    pub timetable: TimetableManyQueryResult,
    pub origin_candidate_count: u32,
    pub projected_origin_count: u32,
    pub target_count: u32,
    pub query_ns: f64,
    pub access_ns: f64,
    pub timetable_ns: f64,
}

#[napi(object)]
pub struct CompactEndpointRouteResult {
    pub query_token: u32,
    pub cache_hit: bool,
    pub origin_cache_hit: bool,
    pub destination_cache_hit: bool,
    pub origin_values: Vec<f64>,
    pub destination_values: Vec<f64>,
    pub origin_path_coordinates: Vec<f64>,
    pub destination_path_coordinates: Vec<f64>,
    pub origin_access_reduction_ns: f64,
    pub destination_access_reduction_ns: f64,
    pub query_ns: f64,
    pub access_reduction_ns: f64,
    pub snap_ns: f64,
    pub origin_search_ns: f64,
    pub destination_search_ns: f64,
    pub origin_settled_nodes: u32,
    pub destination_settled_nodes: u32,
    pub origin_relaxed_edges: u32,
    pub destination_relaxed_edges: u32,
    pub origin_raw_candidates: u32,
    pub destination_raw_candidates: u32,
    pub origin_linked_stations: u32,
    pub destination_linked_stations: u32,
    pub origin_cch_accelerated: bool,
    pub destination_cch_accelerated: bool,
}

fn compact_endpoint_values(endpoints: &EndpointRouteResult, role: &str, index: usize) -> Vec<f64> {
    let (
        member_indices,
        path_member_indices,
        distances_m,
        access_seconds,
        candidate_kinds,
        link_from_stop_keys,
        link_to_stop_keys,
        link_durations,
        link_path_distances_m,
        link_street_verified,
    ) = if role == "destination" {
        (
            &endpoints.destination_member_indices,
            &endpoints.destination_path_member_indices,
            &endpoints.destination_distances_m,
            &endpoints.destination_access_seconds,
            &endpoints.destination_candidate_kinds,
            &endpoints.destination_link_from_stop_keys,
            &endpoints.destination_link_to_stop_keys,
            &endpoints.destination_link_durations,
            &endpoints.destination_link_path_distances_m,
            &endpoints.destination_link_street_verified,
        )
    } else {
        (
            &endpoints.origin_member_indices,
            &endpoints.origin_path_member_indices,
            &endpoints.origin_distances_m,
            &endpoints.origin_access_seconds,
            &endpoints.origin_candidate_kinds,
            &endpoints.origin_link_from_stop_keys,
            &endpoints.origin_link_to_stop_keys,
            &endpoints.origin_link_durations,
            &endpoints.origin_link_path_distances_m,
            &endpoints.origin_link_street_verified,
        )
    };
    vec![
        member_indices[index] as f64,
        path_member_indices[index] as f64,
        distances_m[index],
        access_seconds[index] as f64,
        candidate_kinds[index] as f64,
        link_from_stop_keys[index] as f64,
        link_to_stop_keys[index] as f64,
        link_durations[index] as f64,
        link_path_distances_m[index],
        link_street_verified[index] as f64,
    ]
}

impl CompactEndpointRouteResult {
    fn diagnostics_only(endpoints: &EndpointRouteResult) -> Self {
        Self {
            query_token: endpoints.query_token,
            cache_hit: endpoints.cache_hit,
            origin_cache_hit: endpoints.origin_cache_hit,
            destination_cache_hit: endpoints.destination_cache_hit,
            origin_values: Vec::new(),
            destination_values: Vec::new(),
            origin_path_coordinates: Vec::new(),
            destination_path_coordinates: Vec::new(),
            origin_access_reduction_ns: endpoints.origin_access_reduction_ns,
            destination_access_reduction_ns: endpoints.destination_access_reduction_ns,
            query_ns: endpoints.query_ns,
            access_reduction_ns: endpoints.access_reduction_ns,
            snap_ns: endpoints.snap_ns,
            origin_search_ns: endpoints.origin_search_ns,
            destination_search_ns: endpoints.destination_search_ns,
            origin_settled_nodes: endpoints.origin_settled_nodes,
            destination_settled_nodes: endpoints.destination_settled_nodes,
            origin_relaxed_edges: endpoints.origin_relaxed_edges,
            destination_relaxed_edges: endpoints.destination_relaxed_edges,
            origin_raw_candidates: endpoints.origin_raw_candidates,
            destination_raw_candidates: endpoints.destination_raw_candidates,
            origin_linked_stations: endpoints.origin_linked_stations,
            destination_linked_stations: endpoints.destination_linked_stations,
            origin_cch_accelerated: endpoints.origin_cch_accelerated,
            destination_cch_accelerated: endpoints.destination_cch_accelerated,
        }
    }

    fn from_full(
        endpoints: &EndpointRouteResult,
        origin: usize,
        destination: usize,
        origin_path_coordinates: Vec<f64>,
        destination_path_coordinates: Vec<f64>,
    ) -> Self {
        Self {
            query_token: endpoints.query_token,
            cache_hit: endpoints.cache_hit,
            origin_cache_hit: endpoints.origin_cache_hit,
            destination_cache_hit: endpoints.destination_cache_hit,
            origin_values: compact_endpoint_values(endpoints, "origin", origin),
            destination_values: compact_endpoint_values(endpoints, "destination", destination),
            origin_path_coordinates,
            destination_path_coordinates,
            origin_access_reduction_ns: endpoints.origin_access_reduction_ns,
            destination_access_reduction_ns: endpoints.destination_access_reduction_ns,
            query_ns: endpoints.query_ns,
            access_reduction_ns: endpoints.access_reduction_ns,
            snap_ns: endpoints.snap_ns,
            origin_search_ns: endpoints.origin_search_ns,
            destination_search_ns: endpoints.destination_search_ns,
            origin_settled_nodes: endpoints.origin_settled_nodes,
            destination_settled_nodes: endpoints.destination_settled_nodes,
            origin_relaxed_edges: endpoints.origin_relaxed_edges,
            destination_relaxed_edges: endpoints.destination_relaxed_edges,
            origin_raw_candidates: endpoints.origin_raw_candidates,
            destination_raw_candidates: endpoints.destination_raw_candidates,
            origin_linked_stations: endpoints.origin_linked_stations,
            destination_linked_stations: endpoints.destination_linked_stations,
            origin_cch_accelerated: endpoints.origin_cch_accelerated,
            destination_cch_accelerated: endpoints.destination_cch_accelerated,
        }
    }
}

#[napi(object)]
pub struct EndpointRoleInput {
    pub longitude: f64,
    pub latitude: f64,
    pub maximum_walk_m: f64,
    pub walking_speed_kph: Option<f64>,
    pub access_padding_factor: Option<f64>,
    pub access_overhead_seconds: Option<f64>,
    pub role: String,
    pub disable_cache: Option<bool>,
}

#[napi(object)]
pub struct EndpointRoleResult {
    pub query_token: u32,
    pub cache_hit: bool,
    pub member_indices: Vec<u32>,
    pub path_member_indices: Vec<u32>,
    pub distances_m: Vec<f64>,
    pub access_seconds: Vec<u32>,
    pub candidate_kinds: Vec<u32>,
    pub link_from_stop_keys: Vec<u32>,
    pub link_to_stop_keys: Vec<u32>,
    pub link_durations: Vec<u32>,
    pub link_path_distances_m: Vec<f64>,
    pub link_street_verified: Vec<u32>,
    pub query_ns: f64,
    pub access_reduction_ns: f64,
    pub snap_ns: f64,
    pub search_ns: f64,
    pub settled_nodes: u32,
    pub relaxed_edges: u32,
    pub raw_candidates: u32,
    pub linked_stations: u32,
    pub cch_accelerated: bool,
}

#[napi(object)]
pub struct StreetCchBuildInput {
    pub structure_path: String,
    pub metric_path: String,
    pub order_strategy: Option<String>,
}

#[napi(object)]
pub struct StreetCchBuildResult {
    pub node_count: u32,
    pub edge_count: u32,
    pub cch_arc_count: u32,
    pub distance_units_per_meter: f64,
    pub order_ns: f64,
    pub structure_ns: f64,
    pub customization_ns: f64,
    pub persistence_ns: f64,
    pub total_ns: f64,
    pub structure_bytes: f64,
    pub metric_bytes: f64,
}

#[napi(object)]
pub struct StreetCchLoadInput {
    pub structure_path: String,
    pub metric_path: String,
}

#[napi(object)]
pub struct StreetCchLoadResult {
    pub node_count: u32,
    pub cch_arc_count: u32,
    pub distance_units_per_meter: f64,
    pub workspace_bytes: f64,
    pub load_ns: f64,
}

#[napi(object)]
pub struct StreetCchProbeInput {
    pub source_nodes: Vec<u32>,
    pub source_distances_m: Vec<f64>,
    pub target_nodes: Vec<u32>,
    pub reverse: Option<bool>,
}

#[napi(object)]
pub struct StreetCchProbeResult {
    pub distances_m: Vec<f64>,
    pub query_ns: f64,
    pub source_count: u32,
    pub target_count: u32,
}

#[napi(object)]
pub struct MaterializePathInput {
    pub query_token: u32,
    pub role: String,
    pub member_index: u32,
    pub maximum_points: u32,
}

#[napi(object)]
pub struct MaterializePathResult {
    pub coordinates: Vec<f64>,
}

#[napi(object)]
pub struct StreetPathInput {
    pub origin_lon: f64,
    pub origin_lat: f64,
    pub destination_lon: f64,
    pub destination_lat: f64,
    pub maximum_distance_m: f64,
    pub maximum_points: u32,
}

#[napi(object)]
pub struct AccessMemberPathInput {
    pub origin_member_index: u32,
    pub destination_member_index: u32,
    pub maximum_distance_m: f64,
    pub maximum_points: u32,
    /// Use the physical stop coordinates used to generate stop transfers,
    /// rather than the public entrance anchors used for endpoint access.
    pub stop_transfer: Option<bool>,
}

#[napi(object)]
pub struct StreetPathResult {
    pub found: bool,
    pub distance_m: f64,
    pub origin_snap_distance_m: f64,
    pub destination_snap_distance_m: f64,
    pub coordinates: Vec<f64>,
    pub query_ns: f64,
    pub settled_nodes: u32,
    pub relaxed_edges: u32,
    pub chain_skipped_nodes: u32,
    pub contracted_arc_relaxations: u32,
    pub cch_accelerated: bool,
}

/// Scalar directed street distances for a bounded coordinate matrix. The
/// matrix deliberately returns no path witnesses; callers that need geometry
/// should replay only the selected cells through `route_path`.
#[napi(object)]
pub struct StreetMatrixInput {
    pub origin_coordinates: Vec<f64>,
    pub destination_coordinates: Vec<f64>,
    pub maximum_distance_m: f64,
}

#[napi(object)]
pub struct StreetMatrixResult {
    pub distances_m: Vec<f64>,
    pub ready_pairs: u32,
    pub source_candidates: u32,
    pub destination_candidates: u32,
    pub query_ns: f64,
    pub cch_accelerated: bool,
    pub algorithm: String,
}

#[napi(object)]
pub struct StopTransferGraphInput {
    pub maximum_walk_m: f64,
    pub maximum_neighbors: u32,
}

#[napi(object)]
pub struct StopTransferGraphResult {
    pub from_member_indices: Vec<u32>,
    pub to_member_indices: Vec<u32>,
    pub distances_m: Vec<f64>,
    pub source_searches: u32,
    pub candidate_pairs: u32,
    pub settled_nodes: u32,
    pub relaxed_edges: u32,
    pub build_ns: f64,
}

#[napi(object)]
pub struct KernelDiagnostics {
    pub snapshot_version: u32,
    pub snapshot_bytes: f64,
    pub node_count: u32,
    pub edge_count: u32,
    pub reverse_edge_count: u32,
    pub reverse_graph_bytes: f64,
    pub workspace_bytes: f64,
    pub access_profile_bytes: f64,
    pub native_resident_bytes: f64,
}

#[napi(object)]
pub struct ProfileDiagnostics {
    pub configured: bool,
    pub profile_key: Option<String>,
    pub anchor_count: u32,
    pub member_count: u32,
    pub snapped_member_count: u32,
    pub snap_count: u32,
    pub snap_reference_count: u32,
    pub snap_storage_deduplication_ratio: f64,
    pub grid_cell_count: u32,
    pub station_group_count: u32,
    pub linked_access_edge_count: u32,
    pub cch_target_node_count: u32,
    pub cch_bucket_entries: f64,
    pub cch_bucket_bytes: f64,
    pub cch_bucket_build_ns: f64,
    pub estimated_bytes: f64,
    pub endpoint_cache_entries: u32,
    pub endpoint_cache_estimated_bytes: f64,
    pub endpoint_cache_maximum_entries_per_role: u32,
    pub endpoint_cache_maximum_bytes_per_role: f64,
}

#[napi(object)]
pub struct AccessProfileSnapshotResult {
    pub profile_key: String,
    pub snapshot_bytes: f64,
    pub elapsed_ns: f64,
}

#[napi(object)]
pub struct WorkspaceReservationResult {
    pub maximum_walk_m: f64,
    pub local_nodes: u32,
    pub workspace_bytes: f64,
}

fn build_station_member_csr(
    stop_count: usize,
    member_stop_keys: &[u32],
    member_station_keys: &[u32],
    eligible: &[u8],
) -> (Vec<u32>, Vec<u32>) {
    let mut entries = member_stop_keys
        .iter()
        .zip(member_station_keys.iter())
        .zip(eligible.iter())
        .enumerate()
        .filter_map(|(member, ((stop, station), eligible))| {
            (*eligible != 0 && *station != NO_PROFILE_KEY).then_some((
                *station,
                *stop,
                member as u32,
            ))
        })
        .collect::<Vec<_>>();
    entries.sort_unstable();
    entries.dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
    let mut offsets = vec![0_u32; stop_count + 1];
    for (station, _, _) in &entries {
        offsets[*station as usize + 1] += 1;
    }
    for stop in 0..stop_count {
        offsets[stop + 1] += offsets[stop];
    }
    let members = entries.into_iter().map(|(_, _, member)| member).collect();
    (offsets, members)
}

#[allow(clippy::too_many_arguments)]
fn build_linked_access_csr(
    stop_count: usize,
    transfer_from_stop_keys: &[u32],
    transfer_to_stop_keys: &[u32],
    transfer_to_station_keys: &[u32],
    transfer_min_durations: &[u32],
    transfer_osm_certified: &[u32],
    transfer_path_distances_m: &[f64],
) -> (Vec<u32>, Vec<LinkedAccess>) {
    let mut links = Vec::<LinkedAccess>::new();
    for index in 0..transfer_from_stop_keys.len() {
        let target_station_key = transfer_to_station_keys[index];
        if target_station_key == NO_PROFILE_KEY {
            continue;
        }
        links.push(LinkedAccess {
            from_stop_key: transfer_from_stop_keys[index],
            to_stop_key: transfer_to_stop_keys[index],
            target_station_key,
            duration_seconds: transfer_min_durations[index],
            path_distance_m: transfer_path_distances_m[index],
            street_path_verified: transfer_osm_certified[index] != 0,
        });
    }
    links.sort_by(|left, right| {
        left.from_stop_key
            .cmp(&right.from_stop_key)
            .then_with(|| left.target_station_key.cmp(&right.target_station_key))
            .then_with(|| left.to_stop_key.cmp(&right.to_stop_key))
            .then_with(|| left.duration_seconds.cmp(&right.duration_seconds))
            .then_with(|| left.path_distance_m.total_cmp(&right.path_distance_m))
    });
    links.dedup_by(|left, right| {
        left.from_stop_key == right.from_stop_key
            && left.to_stop_key == right.to_stop_key
            && left.target_station_key == right.target_station_key
            && left.duration_seconds == right.duration_seconds
            && left.path_distance_m.to_bits() == right.path_distance_m.to_bits()
    });
    let mut offsets = vec![0_u32; stop_count + 1];
    for link in &links {
        offsets[link.from_stop_key as usize + 1] += 1;
    }
    for stop in 0..stop_count {
        offsets[stop + 1] += offsets[stop];
    }
    (offsets, links)
}

fn temporary_access_profile_path(snapshot_path: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let mut value = snapshot_path.as_os_str().to_os_string();
    value.push(format!(".{}.{}.tmp", std::process::id(), nonce));
    PathBuf::from(value)
}

#[derive(Default)]
struct SnapWorkspace {
    evaluated_from_nodes: IntegerHashSet<u32>,
    ordered_by_node: Vec<Snap>,
    candidate_nodes: Vec<Snap>,
    projected_edges: Vec<ReciprocalEdgeSnap>,
}

impl SnapWorkspace {
    fn begin(&mut self, expected_nodes: usize) {
        self.evaluated_from_nodes.clear();
        self.ordered_by_node.clear();
        if self.evaluated_from_nodes.capacity() < expected_nodes {
            self.evaluated_from_nodes
                .reserve(expected_nodes - self.evaluated_from_nodes.capacity());
        }
    }
}

#[napi]
pub struct CoordinateKernel {
    snapshot: Snapshot,
    origin_workspace: TileWorkspace,
    destination_workspace: TileWorkspace,
    origin_snap_workspace: SnapWorkspace,
    destination_snap_workspace: SnapWorkspace,
    origin_access_reduction_workspace: AccessReductionWorkspace,
    destination_access_reduction_workspace: AccessReductionWorkspace,
    path_workspace: TileWorkspace,
    reverse_path_workspace: TileWorkspace,
    street_cch: Option<StreetCchIndex>,
    terminal_access: Option<TerminalAccessGraph>,
    profile: Option<AccessProfile>,
    query_token: u32,
    last_origin_frontier: Option<Arc<FrontierSearch>>,
    last_destination_frontier: Option<Arc<FrontierSearch>>,
    origin_cache: HashMap<EndpointCacheKey, Arc<FrontierSearch>>,
    origin_cache_order: VecDeque<EndpointCacheKey>,
    origin_cache_bytes: usize,
    destination_cache: HashMap<EndpointCacheKey, Arc<FrontierSearch>>,
    destination_cache_order: VecDeque<EndpointCacheKey>,
    destination_cache_bytes: usize,
}

#[napi]
impl CoordinateKernel {
    #[napi(constructor)]
    pub fn new(snapshot_path: String) -> napi::Result<Self> {
        let _ = LazyLock::force(&ENDPOINT_ACCESS_POOL);
        let snapshot = Snapshot::open(&snapshot_path)?;
        #[cfg(unix)]
        prefetch_street_snapshot(snapshot_path);
        let origin_workspace = TileWorkspace::new();
        let destination_workspace = TileWorkspace::new();
        let path_workspace = TileWorkspace::new();
        let reverse_path_workspace = TileWorkspace::new();
        Ok(Self {
            snapshot,
            origin_workspace,
            destination_workspace,
            origin_snap_workspace: SnapWorkspace::default(),
            destination_snap_workspace: SnapWorkspace::default(),
            origin_access_reduction_workspace: AccessReductionWorkspace::new(),
            destination_access_reduction_workspace: AccessReductionWorkspace::new(),
            path_workspace,
            reverse_path_workspace,
            street_cch: None,
            terminal_access: None,
            profile: None,
            query_token: 0,
            last_origin_frontier: None,
            last_destination_frontier: None,
            origin_cache: HashMap::new(),
            origin_cache_order: VecDeque::new(),
            origin_cache_bytes: 0,
            destination_cache: HashMap::new(),
            destination_cache_order: VecDeque::new(),
            destination_cache_bytes: 0,
        })
    }

    #[napi]
    pub fn configure_terminal_access(&mut self, path: String) -> napi::Result<()> {
        let graph = TerminalAccessGraph::open(&self.snapshot, Path::new(&path))?;
        self.terminal_access = Some(graph);
        self.clear_endpoint_caches();
        Ok(())
    }

    #[napi]
    pub fn public_access_components(&self) -> napi::Result<Vec<u32>> {
        let profile = self.profile.as_ref().ok_or_else(|| {
            Error::from_reason(
                "Access profile is required to identify the public transit boundary.",
            )
        })?;
        let components = self.snapshot.i32_array("componentByNode")?;
        let mut result: Vec<u32> = profile
            .target_nodes
            .iter()
            .map(|&node| components[node as usize] as u32)
            .collect();
        result.sort_unstable();
        result.dedup();
        Ok(result)
    }

    #[napi]
    pub fn set_access_profile(
        &mut self,
        input: AccessProfileInput,
    ) -> napi::Result<ProfileDiagnostics> {
        let prepare_cch_buckets = input.prepare_cch_buckets.unwrap_or(true);
        let anchor_count = input.anchor_lons.len();
        let member_count = input.member_lons.len();
        if input.anchor_lats.len() != anchor_count
            || input.anchor_member_offsets.len() != anchor_count + 1
            || input.member_lats.len() != member_count
            || input.member_origin_eligible.len() != member_count
            || input.member_destination_eligible.len() != member_count
            || input.anchor_member_offsets[anchor_count] as usize
                != input.anchor_member_indices.len()
            || input
                .anchor_member_indices
                .iter()
                .any(|index| *index as usize >= member_count)
        {
            return Err(Error::from_reason(
                "Rust routing access profile arrays are inconsistent.",
            ));
        }
        if input.profile_key.trim().is_empty() {
            return Err(Error::from_reason(
                "Rust routing access profile key is required.",
            ));
        }
        let member_origin_eligible: Vec<u8> = input
            .member_origin_eligible
            .iter()
            .map(|value| u8::from(*value != 0))
            .collect();
        let member_destination_eligible: Vec<u8> = input
            .member_destination_eligible
            .iter()
            .map(|value| u8::from(*value != 0))
            .collect();
        let member_origin_expansion_eligible = input
            .member_origin_expansion_eligible
            .unwrap_or_else(|| input.member_origin_eligible.clone())
            .into_iter()
            .map(|value| u8::from(value != 0))
            .collect::<Vec<_>>();
        let member_destination_expansion_eligible = input
            .member_destination_expansion_eligible
            .unwrap_or_else(|| input.member_destination_eligible.clone())
            .into_iter()
            .map(|value| u8::from(value != 0))
            .collect::<Vec<_>>();
        let member_stop_keys = input
            .member_stop_keys
            .unwrap_or_else(|| (0..member_count as u32).collect());
        let member_station_keys = input
            .member_station_keys
            .unwrap_or_else(|| vec![NO_PROFILE_KEY; member_count]);
        let stop_lons = input.stop_lons.unwrap_or_else(|| input.member_lons.clone());
        let stop_lats = input.stop_lats.unwrap_or_else(|| input.member_lats.clone());
        let stop_count = stop_lons.len();
        let transfer_from_stop_keys = input.transfer_from_stop_keys.unwrap_or_default();
        let transfer_to_stop_keys = input.transfer_to_stop_keys.unwrap_or_default();
        let transfer_to_station_keys = input.transfer_to_station_keys.unwrap_or_default();
        let transfer_min_durations = input.transfer_min_durations.unwrap_or_default();
        let transfer_osm_certified = input.transfer_osm_certified.unwrap_or_default();
        let transfer_path_distances_m = input.transfer_path_distances_m.unwrap_or_default();
        let transfer_count = transfer_from_stop_keys.len();
        let walking_speed_kph = input.walking_speed_kph.unwrap_or(4.8);
        let access_padding_factor = input.access_padding_factor.unwrap_or(1.0);
        let access_overhead_seconds = input.access_overhead_seconds.unwrap_or(0.0);
        if member_origin_expansion_eligible.len() != member_count
            || member_destination_expansion_eligible.len() != member_count
            || member_stop_keys.len() != member_count
            || member_station_keys.len() != member_count
            || stop_lats.len() != stop_count
            || member_stop_keys
                .iter()
                .any(|key| *key as usize >= stop_count)
            || member_station_keys
                .iter()
                .any(|key| *key != NO_PROFILE_KEY && *key as usize >= stop_count)
            || transfer_to_stop_keys.len() != transfer_count
            || transfer_to_station_keys.len() != transfer_count
            || transfer_min_durations.len() != transfer_count
            || transfer_osm_certified.len() != transfer_count
            || transfer_path_distances_m.len() != transfer_count
            || transfer_from_stop_keys
                .iter()
                .chain(transfer_to_stop_keys.iter())
                .any(|key| *key as usize >= stop_count)
            || transfer_to_station_keys
                .iter()
                .any(|key| *key != NO_PROFILE_KEY && *key as usize >= stop_count)
            || stop_lons
                .iter()
                .chain(stop_lats.iter())
                .any(|value| !value.is_finite())
            || !walking_speed_kph.is_finite()
            || walking_speed_kph <= 0.0
            || !access_padding_factor.is_finite()
            || access_padding_factor <= 0.0
            || !access_overhead_seconds.is_finite()
            || access_overhead_seconds < 0.0
        {
            return Err(Error::from_reason(
                "Rust routing access-reduction profile arrays are inconsistent.",
            ));
        }
        let (origin_station_member_offsets, origin_station_members) = build_station_member_csr(
            stop_count,
            &member_stop_keys,
            &member_station_keys,
            &member_origin_expansion_eligible,
        );
        let (destination_station_member_offsets, destination_station_members) =
            build_station_member_csr(
                stop_count,
                &member_stop_keys,
                &member_station_keys,
                &member_destination_expansion_eligible,
            );
        let (linked_access_offsets, linked_access) = build_linked_access_csr(
            stop_count,
            &transfer_from_stop_keys,
            &transfer_to_stop_keys,
            &transfer_to_station_keys,
            &transfer_min_durations,
            &transfer_osm_certified,
            &transfer_path_distances_m,
        );
        let (reverse_linked_access_offsets, reverse_linked_access) = build_linked_access_csr(
            stop_count,
            &transfer_to_stop_keys,
            &transfer_from_stop_keys,
            &transfer_from_stop_keys,
            &transfer_min_durations,
            &transfer_osm_certified,
            &transfer_path_distances_m,
        );
        // Snap each public access anchor once and retain that frontier once.
        // Transit members reference anchors through the reverse CSR below;
        // no snap vector is copied into every platform in a station.
        let anchor_snaps = (0..anchor_count)
            .into_par_iter()
            .map(|anchor| {
                snaps_for_coordinate(
                    &self.snapshot,
                    self.snapshot.reciprocal_edge_flags(),
                    input.anchor_lons[anchor],
                    input.anchor_lats[anchor],
                )
                .map_err(|error| error.to_string())
            })
            .collect::<std::result::Result<Vec<Vec<Snap>>, String>>()
            .map_err(Error::from_reason)?;
        let mut member_anchor_offsets = vec![0_u32; member_count + 1];
        for &member in &input.anchor_member_indices {
            member_anchor_offsets[member as usize + 1] += 1;
        }
        for member in 0..member_count {
            member_anchor_offsets[member + 1] += member_anchor_offsets[member];
        }
        let mut member_anchor_indices = vec![0_u32; input.anchor_member_indices.len()];
        let mut member_anchor_cursors = member_anchor_offsets[..member_count].to_vec();
        for anchor in 0..anchor_count {
            let start = input.anchor_member_offsets[anchor] as usize;
            let end = input.anchor_member_offsets[anchor + 1] as usize;
            for &member in &input.anchor_member_indices[start..end] {
                let cursor = &mut member_anchor_cursors[member as usize];
                member_anchor_indices[*cursor as usize] = anchor as u32;
                *cursor += 1;
            }
        }
        let mut grid_entries = Vec::<(u64, u32)>::with_capacity(anchor_count);
        for anchor in 0..anchor_count {
            let (latitude_cell, longitude_cell) =
                access_cell(input.anchor_lats[anchor], input.anchor_lons[anchor]);
            grid_entries.push((
                access_cell_key(latitude_cell, longitude_cell),
                anchor as u32,
            ));
        }
        grid_entries.sort_unstable();
        let mut grid_keys = Vec::<u64>::new();
        let mut grid_offsets = Vec::<u32>::new();
        let mut grid_anchors = Vec::<u32>::with_capacity(grid_entries.len());
        let mut previous_grid_key = None;
        for (key, anchor) in grid_entries {
            if previous_grid_key != Some(key) {
                grid_keys.push(key);
                grid_offsets.push(grid_anchors.len() as u32);
                previous_grid_key = Some(key);
            }
            grid_anchors.push(anchor);
        }
        grid_offsets.push(grid_anchors.len() as u32);

        // Every access anchor and snap is immutable for the configured GTFS +
        // street identity. Build the node-to-member target CSR once so an
        // endpoint query only activates nearby members; it no longer creates
        // and sorts (node, member, distance) tuples on every route.
        let mut target_entries = Vec::<(u32, u32, f64)>::new();
        for (anchor, snaps) in anchor_snaps.iter().enumerate().take(anchor_count) {
            let member_start = input.anchor_member_offsets[anchor] as usize;
            let member_end = input.anchor_member_offsets[anchor + 1] as usize;
            for &member in &input.anchor_member_indices[member_start..member_end] {
                for snap in snaps {
                    target_entries.push((snap.node, member, snap.distance_m));
                }
            }
        }
        target_entries.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| left.2.total_cmp(&right.2))
        });
        target_entries.dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
        let mut target_nodes = Vec::<u32>::new();
        let mut target_offsets = Vec::<u32>::new();
        let mut targets = Vec::<Target>::with_capacity(target_entries.len());
        let mut previous_target_node = None;
        for (node, member, snap_distance_m) in target_entries {
            if previous_target_node != Some(node) {
                target_nodes.push(node);
                target_offsets.push(targets.len() as u32);
                previous_target_node = Some(node);
            }
            targets.push(Target {
                member,
                snap_distance_m,
            });
        }
        target_offsets.push(targets.len() as u32);
        self.profile = Some(AccessProfile {
            key: input.profile_key,
            anchor_lons: input.anchor_lons,
            anchor_lats: input.anchor_lats,
            anchor_member_offsets: input.anchor_member_offsets,
            anchor_member_indices: input.anchor_member_indices,
            anchor_snaps,
            member_anchor_offsets,
            member_anchor_indices,
            member_lons: input.member_lons,
            member_lats: input.member_lats,
            member_origin_eligible,
            member_destination_eligible,
            member_stop_keys,
            member_station_keys,
            stop_lons,
            stop_lats,
            origin_station_member_offsets,
            origin_station_members,
            destination_station_member_offsets,
            destination_station_members,
            linked_access_offsets,
            linked_access,
            reverse_linked_access_offsets,
            reverse_linked_access,
            walking_speed_kph,
            access_padding_factor,
            access_overhead_seconds,
            grid_keys,
            grid_offsets,
            grid_anchors,
            target_nodes,
            target_offsets,
            targets,
        });
        if let Some(index) = &mut self.street_cch {
            index.origin_buckets = None;
            index.destination_buckets = None;
            index.bucket_build_ns = 0.0;
            if prepare_cch_buckets {
                let profile = self
                    .profile
                    .as_ref()
                    .expect("access profile was installed immediately above");
                prepare_street_cch_target_buckets(profile, index)?;
            }
        }
        self.last_origin_frontier = None;
        self.last_destination_frontier = None;
        self.origin_cache.clear();
        self.origin_cache_order.clear();
        self.origin_cache_bytes = 0;
        self.destination_cache.clear();
        self.destination_cache_order.clear();
        self.destination_cache_bytes = 0;
        Ok(self.profile_diagnostics())
    }

    #[napi]
    pub fn load_access_profile_snapshot(
        &mut self,
        snapshot_path: String,
        expected_profile_key: String,
    ) -> napi::Result<AccessProfileSnapshotResult> {
        let started = Instant::now();
        let path = Path::new(&snapshot_path);
        let metadata = fs::metadata(path).map_err(|error| {
            Error::from_reason(format!("Unable to inspect native access profile: {error}"))
        })?;
        if metadata.len() == 0 || metadata.len() > MAXIMUM_ACCESS_PROFILE_SNAPSHOT_BYTES {
            return Err(Error::from_reason(
                "Persisted native access profile is empty or exceeds its size guard.",
            ));
        }
        let file = File::open(path).map_err(|error| {
            Error::from_reason(format!("Unable to open native access profile: {error}"))
        })?;
        let mmap = unsafe { Mmap::map(&file) }.map_err(|error| {
            Error::from_reason(format!(
                "Unable to memory-map native access profile: {error}"
            ))
        })?;
        if mmap.len() < ACCESS_PROFILE_SNAPSHOT_HEADER_BYTES
            || mmap[..8] != ACCESS_PROFILE_SNAPSHOT_MAGIC
            || snapshot_u32(&mmap, 8) != Some(ACCESS_PROFILE_SNAPSHOT_VERSION)
        {
            return Err(Error::from_reason(
                "Persisted native access profile has an unsupported schema.",
            ));
        }
        let flags = snapshot_u32(&mmap, 12).ok_or_else(|| {
            Error::from_reason("Persisted native access profile header is truncated.")
        })?;
        let value_usize = |offset| -> napi::Result<usize> {
            usize::try_from(snapshot_u64(&mmap, offset).ok_or_else(|| {
                Error::from_reason("Persisted native access profile header is truncated.")
            })?)
            .map_err(|_| Error::from_reason("Persisted native access profile size overflows."))
        };
        let profile_bytes = value_usize(16)?;
        let cch_fingerprint = snapshot_u64(&mmap, 24).ok_or_else(|| {
            Error::from_reason("Persisted native access profile header is truncated.")
        })?;
        let maximum_distance = snapshot_u32(&mmap, 32).ok_or_else(|| {
            Error::from_reason("Persisted native access profile header is truncated.")
        })?;
        let origin_offsets_len = value_usize(40)?;
        let origin_entries_len = value_usize(48)?;
        let destination_offsets_len = value_usize(56)?;
        let destination_entries_len = value_usize(64)?;
        let declared_total_bytes = value_usize(72)?;
        let layout = access_profile_snapshot_layout(
            profile_bytes,
            origin_offsets_len,
            origin_entries_len,
            destination_offsets_len,
            destination_entries_len,
        )
        .filter(|layout| {
            layout.total_bytes == mmap.len() && layout.total_bytes == declared_total_bytes
        })
        .ok_or_else(|| {
            Error::from_reason("Persisted native access profile layout is inconsistent.")
        })?;
        let profile: AccessProfile = bincode::DefaultOptions::new()
            .with_fixint_encoding()
            .with_limit(MAXIMUM_ACCESS_PROFILE_SNAPSHOT_BYTES)
            .deserialize(&mmap[layout.profile_start..layout.profile_end])
            .map_err(|error| {
                Error::from_reason(format!("Unable to decode native access profile: {error}"))
            })?;
        profile
            .validate(&self.snapshot, &expected_profile_key)
            .map_err(Error::from_reason)?;
        match self.street_cch.as_mut() {
            Some(index) => {
                if flags != 1 || index.fingerprint() != cch_fingerprint {
                    return Err(Error::from_reason(
                        "Persisted native access profile targets a different street CCH.",
                    ));
                }
                let expected_maximum_distance =
                    (CCH_MAXIMUM_QUERY_DISTANCE_M * CCH_DISTANCE_UNITS_PER_METER)
                        .round()
                        .min((cch::INF_WEIGHT - 1) as f64) as u32;
                let node_count = index.structure.view().node_count() as usize;
                let mmap = Arc::new(mmap);
                let origin = CchTargetBuckets::mapped(
                    Arc::clone(&mmap),
                    layout.origin_offsets_start,
                    origin_offsets_len,
                    layout.origin_entries_start,
                    origin_entries_len,
                    maximum_distance,
                )
                .map_err(Error::from_reason)?;
                let destination = CchTargetBuckets::mapped(
                    mmap,
                    layout.destination_offsets_start,
                    destination_offsets_len,
                    layout.destination_entries_start,
                    destination_entries_len,
                    maximum_distance,
                )
                .map_err(Error::from_reason)?;
                origin
                    .validate(
                        node_count,
                        profile.target_nodes.len(),
                        expected_maximum_distance,
                    )
                    .map_err(Error::from_reason)?;
                destination
                    .validate(
                        node_count,
                        profile.target_nodes.len(),
                        expected_maximum_distance,
                    )
                    .map_err(Error::from_reason)?;
                index.origin_buckets = Some(origin);
                index.destination_buckets = Some(destination);
                index.bucket_build_ns = 0.0;
            }
            None if flags == 0
                && origin_offsets_len == 0
                && origin_entries_len == 0
                && destination_offsets_len == 0
                && destination_entries_len == 0 => {}
            None => {
                return Err(Error::from_reason(
                    "Persisted native access profile contains street CCH data but no CCH is loaded.",
                ));
            }
        }
        self.profile = Some(profile);
        self.last_origin_frontier = None;
        self.last_destination_frontier = None;
        self.origin_cache.clear();
        self.origin_cache_order.clear();
        self.origin_cache_bytes = 0;
        self.destination_cache.clear();
        self.destination_cache_order.clear();
        self.destination_cache_bytes = 0;
        Ok(AccessProfileSnapshotResult {
            profile_key: expected_profile_key,
            snapshot_bytes: metadata.len() as f64,
            elapsed_ns: started.elapsed().as_nanos() as f64,
        })
    }

    #[napi]
    pub fn persist_access_profile_snapshot(
        &self,
        snapshot_path: String,
    ) -> napi::Result<AccessProfileSnapshotResult> {
        let started = Instant::now();
        let profile = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?;
        let (
            flags,
            cch_fingerprint,
            maximum_distance,
            origin_offsets,
            origin_entries,
            destination_offsets,
            destination_entries,
        ) = if let Some(index) = self.street_cch.as_ref() {
            let origin = index.origin_buckets.as_ref().ok_or_else(|| {
                Error::from_reason("Street CCH origin target buckets are not prepared.")
            })?;
            let destination = index.destination_buckets.as_ref().ok_or_else(|| {
                Error::from_reason("Street CCH destination target buckets are not prepared.")
            })?;
            (
                1_u32,
                index.fingerprint(),
                origin.maximum_distance,
                origin.offsets(),
                origin.entries(),
                destination.offsets(),
                destination.entries(),
            )
        } else {
            (0_u32, 0_u64, 0_u32, &[][..], &[][..], &[][..], &[][..])
        };
        let destination = Path::new(&snapshot_path);
        if destination.parent().is_none_or(|parent| !parent.is_dir()) {
            return Err(Error::from_reason(
                "Native access-profile snapshot directory does not exist.",
            ));
        }
        let temporary = temporary_access_profile_path(destination);
        let write_result = (|| -> std::result::Result<u64, String> {
            let profile_bytes = bincode::DefaultOptions::new()
                .with_fixint_encoding()
                .with_limit(MAXIMUM_ACCESS_PROFILE_SNAPSHOT_BYTES)
                .serialize(profile)
                .map_err(|error| error.to_string())?;
            let layout = access_profile_snapshot_layout(
                profile_bytes.len(),
                origin_offsets.len(),
                origin_entries.len(),
                destination_offsets.len(),
                destination_entries.len(),
            )
            .ok_or_else(|| "Native access-profile snapshot size overflows.".to_owned())?;
            if layout.total_bytes as u64 > MAXIMUM_ACCESS_PROFILE_SNAPSHOT_BYTES {
                return Err("Native access-profile snapshot exceeds its size guard.".to_owned());
            }
            let mut header = [0_u8; ACCESS_PROFILE_SNAPSHOT_HEADER_BYTES];
            header[..8].copy_from_slice(&ACCESS_PROFILE_SNAPSHOT_MAGIC);
            header[8..12].copy_from_slice(&ACCESS_PROFILE_SNAPSHOT_VERSION.to_le_bytes());
            header[12..16].copy_from_slice(&flags.to_le_bytes());
            header[16..24].copy_from_slice(&(profile_bytes.len() as u64).to_le_bytes());
            header[24..32].copy_from_slice(&cch_fingerprint.to_le_bytes());
            header[32..36].copy_from_slice(&maximum_distance.to_le_bytes());
            header[40..48].copy_from_slice(&(origin_offsets.len() as u64).to_le_bytes());
            header[48..56].copy_from_slice(&(origin_entries.len() as u64).to_le_bytes());
            header[56..64].copy_from_slice(&(destination_offsets.len() as u64).to_le_bytes());
            header[64..72].copy_from_slice(&(destination_entries.len() as u64).to_le_bytes());
            header[72..80].copy_from_slice(&(layout.total_bytes as u64).to_le_bytes());
            let file = File::create(&temporary).map_err(|error| error.to_string())?;
            let mut writer = BufWriter::new(file);
            writer
                .write_all(&header)
                .map_err(|error| error.to_string())?;
            writer
                .write_all(&profile_bytes)
                .map_err(|error| error.to_string())?;
            let mut position = layout.profile_end;
            for (start, bytes) in [
                (
                    layout.origin_offsets_start,
                    snapshot_slice_bytes(origin_offsets),
                ),
                (
                    layout.origin_entries_start,
                    snapshot_slice_bytes(origin_entries),
                ),
                (
                    layout.destination_offsets_start,
                    snapshot_slice_bytes(destination_offsets),
                ),
                (
                    layout.destination_entries_start,
                    snapshot_slice_bytes(destination_entries),
                ),
            ] {
                write_snapshot_padding(&mut writer, &mut position, start)
                    .map_err(|error| error.to_string())?;
                writer.write_all(bytes).map_err(|error| error.to_string())?;
                position += bytes.len();
            }
            if position != layout.total_bytes {
                return Err("Native access-profile writer produced an invalid length.".to_owned());
            }
            writer.flush().map_err(|error| error.to_string())?;
            let file = writer
                .into_inner()
                .map_err(|error| error.into_error().to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
            fs::metadata(destination)
                .map(|metadata| metadata.len())
                .map_err(|error| error.to_string())
        })();
        let snapshot_bytes = match write_result {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(Error::from_reason(format!(
                    "Unable to persist native access profile: {error}"
                )));
            }
        };
        Ok(AccessProfileSnapshotResult {
            profile_key: profile.key.clone(),
            snapshot_bytes: snapshot_bytes as f64,
            elapsed_ns: started.elapsed().as_nanos() as f64,
        })
    }

    #[napi]
    pub fn route_endpoints(
        &mut self,
        input: EndpointRouteInput,
    ) -> napi::Result<EndpointRouteResult> {
        if !input.maximum_walk_m.is_finite() || input.maximum_walk_m <= 0.0 {
            return Err(Error::from_reason(
                "maximumWalkM must be a positive finite number.",
            ));
        }
        let profile = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?;
        let access_timing = AccessTiming::resolve(
            profile,
            input.walking_speed_kph,
            input.access_padding_factor,
            input.access_overhead_seconds,
        )?;
        let query_started = Instant::now();
        let snapshot = &self.snapshot;
        let disable_cache = input.disable_cache.unwrap_or(false);
        let (origin_result, destination_result) = if input.maximum_walk_m
            <= CCH_MAXIMUM_QUERY_DISTANCE_M
            && let Some(index) = self.street_cch.as_mut()
        {
            let StreetCchIndex {
                structure,
                metric,
                forward_query,
                reverse_query,
                origin_member_workspace,
                destination_member_workspace,
                origin_buckets,
                destination_buckets,
                ..
            } = index;
            join_endpoint_access(
                || {
                    let result = cached_cch_frontier_search(
                        snapshot,
                        self.terminal_access.as_ref(),
                        self.snapshot.reciprocal_edge_flags(),
                        &mut self.origin_workspace,
                        &mut self.origin_snap_workspace,
                        profile,
                        structure,
                        metric,
                        forward_query,
                        origin_member_workspace,
                        origin_buckets.as_ref(),
                        &mut self.origin_cache,
                        &mut self.origin_cache_order,
                        &mut self.origin_cache_bytes,
                        input.origin_lon,
                        input.origin_lat,
                        input.maximum_walk_m,
                        false,
                        disable_cache,
                    )?;
                    let access = reduce_access_frontier(
                        profile,
                        access_timing,
                        &result.frontier,
                        &mut self.origin_access_reduction_workspace,
                        AccessEndpoint {
                            longitude: input.origin_lon,
                            latitude: input.origin_lat,
                            maximum_walk_m: input.maximum_walk_m,
                            origin_role: true,
                        },
                    );
                    Ok::<_, napi::Error>((result, access))
                },
                || {
                    let result = cached_cch_frontier_search(
                        snapshot,
                        self.terminal_access.as_ref(),
                        self.snapshot.reciprocal_edge_flags(),
                        &mut self.destination_workspace,
                        &mut self.destination_snap_workspace,
                        profile,
                        structure,
                        metric,
                        reverse_query,
                        destination_member_workspace,
                        destination_buckets.as_ref(),
                        &mut self.destination_cache,
                        &mut self.destination_cache_order,
                        &mut self.destination_cache_bytes,
                        input.destination_lon,
                        input.destination_lat,
                        input.maximum_walk_m,
                        true,
                        disable_cache,
                    )?;
                    let access = reduce_access_frontier(
                        profile,
                        access_timing,
                        &result.frontier,
                        &mut self.destination_access_reduction_workspace,
                        AccessEndpoint {
                            longitude: input.destination_lon,
                            latitude: input.destination_lat,
                            maximum_walk_m: input.maximum_walk_m,
                            origin_role: false,
                        },
                    );
                    Ok::<_, napi::Error>((result, access))
                },
            )
        } else {
            let origin_result = (|| {
                let result = cached_frontier_search(
                    snapshot,
                    self.terminal_access.as_ref(),
                    self.snapshot.reciprocal_edge_flags(),
                    &mut self.origin_workspace,
                    &mut self.origin_snap_workspace,
                    profile,
                    &mut self.origin_cache,
                    &mut self.origin_cache_order,
                    &mut self.origin_cache_bytes,
                    input.origin_lon,
                    input.origin_lat,
                    input.maximum_walk_m,
                    false,
                    disable_cache,
                )?;
                let access = reduce_access_frontier(
                    profile,
                    access_timing,
                    &result.frontier,
                    &mut self.origin_access_reduction_workspace,
                    AccessEndpoint {
                        longitude: input.origin_lon,
                        latitude: input.origin_lat,
                        maximum_walk_m: input.maximum_walk_m,
                        origin_role: true,
                    },
                );
                Ok::<_, napi::Error>((result, access))
            })();
            let destination_result = (|| {
                let result = cached_frontier_search(
                    snapshot,
                    self.terminal_access.as_ref(),
                    self.snapshot.reciprocal_edge_flags(),
                    &mut self.destination_workspace,
                    &mut self.destination_snap_workspace,
                    profile,
                    &mut self.destination_cache,
                    &mut self.destination_cache_order,
                    &mut self.destination_cache_bytes,
                    input.destination_lon,
                    input.destination_lat,
                    input.maximum_walk_m,
                    true,
                    disable_cache,
                )?;
                let access = reduce_access_frontier(
                    profile,
                    access_timing,
                    &result.frontier,
                    &mut self.destination_access_reduction_workspace,
                    AccessEndpoint {
                        longitude: input.destination_lon,
                        latitude: input.destination_lat,
                        maximum_walk_m: input.maximum_walk_m,
                        origin_role: false,
                    },
                );
                Ok::<_, napi::Error>((result, access))
            })();
            (origin_result, destination_result)
        };
        let (origin_result, origin_access) = origin_result?;
        let (destination_result, destination_access) = destination_result?;
        let origin = origin_result.frontier;
        let destination = destination_result.frontier;
        let origin_cache_hit = origin_result.cache_hit;
        let destination_cache_hit = destination_result.cache_hit;
        let snap_ns = origin_result.snap_ns + destination_result.snap_ns;
        let origin_search_ns = origin_result.search_ns;
        let destination_search_ns = destination_result.search_ns;
        let access_reduction_ns = origin_access
            .reduction_ns
            .max(destination_access.reduction_ns);

        self.query_token = self.query_token.wrapping_add(1);
        if self.query_token == 0 {
            self.query_token = 1;
        }
        self.last_origin_frontier = Some(Arc::clone(&origin));
        self.last_destination_frontier = Some(Arc::clone(&destination));
        Ok(EndpointRouteResult {
            query_token: self.query_token,
            cache_hit: origin_cache_hit && destination_cache_hit,
            origin_cache_hit,
            destination_cache_hit,
            origin_member_indices: origin_access.member_indices,
            origin_path_member_indices: origin_access.path_member_indices,
            origin_distances_m: origin_access.distances_m,
            origin_access_seconds: origin_access.access_seconds,
            origin_candidate_kinds: origin_access.candidate_kinds,
            origin_link_from_stop_keys: origin_access.link_from_stop_keys,
            origin_link_to_stop_keys: origin_access.link_to_stop_keys,
            origin_link_durations: origin_access.link_durations,
            origin_link_path_distances_m: origin_access.link_path_distances_m,
            origin_link_street_verified: origin_access.link_street_verified,
            origin_access_reduction_ns: origin_access.reduction_ns,
            destination_member_indices: destination_access.member_indices,
            destination_path_member_indices: destination_access.path_member_indices,
            destination_distances_m: destination_access.distances_m,
            destination_access_seconds: destination_access.access_seconds,
            destination_candidate_kinds: destination_access.candidate_kinds,
            destination_link_from_stop_keys: destination_access.link_from_stop_keys,
            destination_link_to_stop_keys: destination_access.link_to_stop_keys,
            destination_link_durations: destination_access.link_durations,
            destination_link_path_distances_m: destination_access.link_path_distances_m,
            destination_link_street_verified: destination_access.link_street_verified,
            destination_access_reduction_ns: destination_access.reduction_ns,
            query_ns: query_started.elapsed().as_nanos() as f64,
            access_reduction_ns,
            snap_ns,
            origin_search_ns,
            destination_search_ns,
            origin_settled_nodes: origin.settled_nodes,
            destination_settled_nodes: destination.settled_nodes,
            origin_relaxed_edges: origin.relaxed_edges,
            destination_relaxed_edges: destination.relaxed_edges,
            origin_raw_candidates: origin.member_indices.len() as u32,
            destination_raw_candidates: destination.member_indices.len() as u32,
            origin_linked_stations: origin_access.linked_stations,
            destination_linked_stations: destination_access.linked_stations,
            origin_cch_accelerated: origin.cch_accelerated,
            destination_cch_accelerated: destination.cch_accelerated,
        })
    }

    /// One native boundary for the complete coordinate-access plus exact
    /// timetable search. `member_timetable_stops` is a precomputed immutable
    /// profile-member -> active-kernel-stop projection; `u32::MAX` means the
    /// member is outside the active service kernel.
    #[napi]
    pub fn route_endpoints_timetable_scalar(
        &mut self,
        mut timetable: ClassInstance<'_, TimetableKernel>,
        input: CoordinateTimetableInput,
    ) -> napi::Result<CoordinateTimetableResult> {
        let started = Instant::now();
        let member_count = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?
            .member_lons
            .len();
        let arrive_by_bounds_valid = match (input.arrive_by_earliest, input.arrive_by_deadline) {
            (None, None) => true,
            (Some(earliest), Some(deadline)) => {
                earliest.is_finite() && deadline.is_finite() && deadline >= earliest
            }
            _ => false,
        };
        if input.member_timetable_stops.len() != member_count || !arrive_by_bounds_valid {
            return Err(Error::from_reason(
                "Coordinate timetable projection or arrive-by bounds are inconsistent.",
            ));
        }
        let access_started = Instant::now();
        let endpoints = self.route_endpoints(EndpointRouteInput {
            origin_lon: input.origin_lon,
            origin_lat: input.origin_lat,
            destination_lon: input.destination_lon,
            destination_lat: input.destination_lat,
            maximum_walk_m: input.maximum_walk_m,
            walking_speed_kph: input.walking_speed_kph,
            access_padding_factor: input.access_padding_factor,
            access_overhead_seconds: input.access_overhead_seconds,
            disable_cache: input.disable_cache,
        })?;
        let access_ns = access_started.elapsed().as_nanos() as f64;
        let origin_candidate_count = endpoints.origin_member_indices.len() as u32;
        let destination_candidate_count = endpoints.destination_member_indices.len() as u32;
        let minimum_origin_access_seconds = endpoints.origin_access_seconds.iter().copied().min();
        let minimum_destination_access_seconds =
            endpoints.destination_access_seconds.iter().copied().min();
        let direct_walk_started = Instant::now();
        let mut direct_walk_cch_checked = false;
        let mut direct_walk_distance_m = None;
        let minimum_origin_access = minimum_origin_access_seconds.unwrap_or(u32::MAX) as f64;
        let minimum_destination_access =
            minimum_destination_access_seconds.unwrap_or(u32::MAX) as f64;
        let walking_speed_kph = input.walking_speed_kph.unwrap_or_else(|| {
            self.profile
                .as_ref()
                .map_or(3.8, |profile| profile.walking_speed_kph)
        });
        let crow_flight_m = haversine_m(
            input.origin_lon,
            input.origin_lat,
            input.destination_lon,
            input.destination_lat,
        );
        let physical_walk_lower_bound_seconds =
            crow_flight_m / 1_000.0 / walking_speed_kph * 3_600.0;
        if input.maximum_walk_m <= CCH_MAXIMUM_QUERY_DISTANCE_M
            && crow_flight_m <= input.maximum_walk_m
            && physical_walk_lower_bound_seconds
                < minimum_origin_access + minimum_destination_access
            && let (Some(origin), Some(destination), Some(index)) = (
                self.last_origin_frontier.as_ref(),
                self.last_destination_frontier.as_ref(),
                self.street_cch.as_mut(),
            )
        {
            direct_walk_cch_checked = true;
            let sources = origin
                .source_snaps
                .iter()
                .map(|snap| {
                    (
                        snap.node,
                        (snap.distance_m * CCH_DISTANCE_UNITS_PER_METER)
                            .round()
                            .clamp(0.0, (cch::INF_WEIGHT - 1) as f64)
                            as u32,
                    )
                })
                .collect::<Vec<_>>();
            let targets = destination
                .source_snaps
                .iter()
                .map(|snap| snap.node)
                .collect::<Vec<_>>();
            let structure = index.structure.view();
            let metric = index.metric.view();
            let graph_distances = index
                .forward_query
                .distances(&structure, &metric, &sources, &targets);
            let maximum_units = (input.maximum_walk_m * CCH_DISTANCE_UNITS_PER_METER)
                .round()
                .min((cch::INF_WEIGHT - 1) as f64) as u32;
            let best = graph_distances
                .iter()
                .zip(&destination.source_snaps)
                .filter_map(|(&distance, snap)| {
                    if distance == cch::INF_WEIGHT {
                        return None;
                    }
                    let connector = (snap.distance_m * CCH_DISTANCE_UNITS_PER_METER)
                        .round()
                        .clamp(0.0, (cch::INF_WEIGHT - 1) as f64)
                        as u32;
                    let total = distance.saturating_add(connector);
                    (total <= maximum_units).then_some(total)
                })
                .min();
            direct_walk_distance_m =
                best.map(|distance| distance as f64 / CCH_DISTANCE_UNITS_PER_METER);
        }
        let private_direct = self
            .last_origin_frontier
            .as_ref()
            .and_then(|f| f.terminal_attachment.as_ref())
            .and_then(|a| {
                self.last_destination_frontier
                    .as_ref()
                    .and_then(|f| f.terminal_attachment.as_ref())
                    .and_then(|b| a.direct_to(b))
            });
        if let Some((distance, _)) = private_direct
            && distance <= input.maximum_walk_m
        {
            direct_walk_distance_m =
                Some(direct_walk_distance_m.map_or(distance, |d| d.min(distance)));
        }
        let direct_walk_query_ns = direct_walk_started.elapsed().as_nanos() as f64;
        // Only the strict endpoint-access lower-bound winner can return before
        // the timetable result is consumed. Materialize that uncommon path in
        // this native call, reusing the exact endpoint snaps, so the complete
        // coordinate OD does not pay for a second Node-API call and a second
        // spatial snap. No path or endpoint result is cached.
        let mut direct_walk_path_checked = false;
        let mut direct_walk_path = None;
        let mut direct_walk_path_query_ns = 0.0;
        let mut direct_walk_access_dominates = false;
        if input.enable_direct_walk_dominance
            && direct_walk_distance_m.is_some_and(|distance_m| {
                distance_m / 1_000.0 / walking_speed_kph * 3_600.0
                    < minimum_origin_access + minimum_destination_access
            })
        {
            direct_walk_path_checked = true;
            let path_started = Instant::now();
            let origin_snaps = self
                .last_origin_frontier
                .as_ref()
                .map_or_else(Vec::new, |frontier| frontier.source_snaps.clone());
            let destination_snaps = self
                .last_destination_frontier
                .as_ref()
                .map_or_else(Vec::new, |frontier| frontier.source_snaps.clone());
            let path = run_point_path(
                &self.snapshot,
                &mut self.path_workspace,
                &mut self.reverse_path_workspace,
                &origin_snaps,
                &destination_snaps,
                [
                    [input.origin_lon, input.origin_lat],
                    [input.destination_lon, input.destination_lat],
                ],
                PointPathOptions {
                    maximum_distance_m: input.maximum_walk_m,
                    contract_chains: true,
                },
            )?;
            let path = finish_terminal_point_path(
                path,
                self.last_origin_frontier
                    .as_ref()
                    .and_then(|f| f.terminal_attachment.as_deref()),
                self.last_destination_frontier
                    .as_ref()
                    .and_then(|f| f.terminal_attachment.as_deref()),
                input.maximum_walk_m,
            );
            let path_result = street_path_result(
                &self.snapshot,
                self.terminal_access.as_ref(),
                path,
                160,
                path_started,
            )?;
            direct_walk_access_dominates = path_result.found
                && path_result.distance_m / 1_000.0 / walking_speed_kph * 3_600.0
                    < minimum_origin_access + minimum_destination_access;
            direct_walk_path = Some(path_result);
            direct_walk_path_query_ns = path_started.elapsed().as_nanos() as f64;
        }
        let timetable_started = Instant::now();
        let mut arrive_by_result = None;
        let mut arrive_by_ns = 0.0;
        let mut forward_timetable_ns = 0.0;
        let mut timetable_result = if direct_walk_access_dominates {
            None
        } else {
            let mut origin_stops = Vec::<u32>::new();
            let mut origin_walk_seconds = Vec::<f64>::new();
            let mut origin_candidate_indices = Vec::<u32>::new();
            for (candidate, (&member, &walk_seconds)) in endpoints
                .origin_member_indices
                .iter()
                .zip(&endpoints.origin_access_seconds)
                .enumerate()
            {
                let stop = input.member_timetable_stops[member as usize];
                if stop == u32::MAX {
                    continue;
                }
                origin_stops.push(stop);
                origin_walk_seconds.push(walk_seconds as f64);
                origin_candidate_indices.push(candidate as u32);
            }
            let mut destination_stops = Vec::<u32>::new();
            let mut destination_walk_seconds = Vec::<f64>::new();
            let mut destination_candidate_indices = Vec::<u32>::new();
            for (candidate, (&member, &walk_seconds)) in endpoints
                .destination_member_indices
                .iter()
                .zip(&endpoints.destination_access_seconds)
                .enumerate()
            {
                let stop = input.member_timetable_stops[member as usize];
                if stop == u32::MAX {
                    continue;
                }
                destination_stops.push(stop);
                destination_walk_seconds.push(walk_seconds as f64);
                destination_candidate_indices.push(candidate as u32);
            }

            let arrive_by_bounds = input.arrive_by_earliest.zip(input.arrive_by_deadline);
            let departure = if let Some((earliest, deadline)) = arrive_by_bounds {
                let reverse_started = Instant::now();
                let reverse = timetable.route_arrive_by_csa(TimetableArriveByQueryInput {
                    origin_stops: origin_stops.clone(),
                    origin_walk_seconds: origin_walk_seconds.clone(),
                    origin_candidate_indices: origin_candidate_indices.clone(),
                    destination_stops: destination_stops.clone(),
                    destination_walk_seconds: destination_walk_seconds.clone(),
                    destination_candidate_indices: destination_candidate_indices.clone(),
                    earliest,
                    deadline,
                    allow_pre_ride_transfers: input.allow_pre_ride_transfers,
                    allow_post_ride_transfers: Some(false),
                    maximum_boardings: input.maximum_boardings,
                })?;
                arrive_by_ns = reverse_started.elapsed().as_nanos() as f64;
                let latest_departure = reverse.latest_departure;
                arrive_by_result = Some(reverse);
                latest_departure
            } else {
                Some(input.departure)
            };

            if let Some(departure) = departure {
                let forward_started = Instant::now();
                let result = timetable.route_scalar_csa(TimetableQueryInput {
                    origin_stops,
                    origin_walk_seconds,
                    origin_candidate_indices,
                    destination_stops,
                    destination_walk_seconds,
                    destination_candidate_indices,
                    departure,
                    horizon: input.horizon,
                    allow_pre_ride_transfers: input.allow_pre_ride_transfers,
                    allow_post_ride_transfers: Some(false),
                    maximum_boardings: input.maximum_boardings,
                })?;
                forward_timetable_ns = forward_started.elapsed().as_nanos() as f64;
                Some(result)
            } else {
                None
            }
        };
        let timetable_ns = if direct_walk_access_dominates {
            0.0
        } else {
            timetable_started.elapsed().as_nanos() as f64
        };
        let boarding_count = timetable_result.as_ref().map_or(0, |result| {
            result
                .chain_kinds
                .iter()
                .filter(|kind| **kind != 1 && **kind != 3)
                .count()
        });
        let selected_origin_step = timetable_result
            .as_ref()
            .and_then(|result| result.chain_kinds.iter().position(|kind| *kind == 3));
        let selected_origin = selected_origin_step.and_then(|step| {
            usize::try_from(timetable_result.as_ref()?.chain_trip_or_candidate[step]).ok()
        });
        let selected_destination = timetable_result
            .as_ref()
            .and_then(|result| result.best_destination_index)
            .map(|index| index as usize);
        // Fastest coordinate queries need the full endpoint frontier only when
        // a three-or-more-boarding scalar witness still requires the bounded
        // Pareto certifier. For one boarding there is no lower transit
        // boarding count; for exactly two, the scalar run state has already
        // exhausted every one-boarding run and resolves equal-arrival ties by
        // boardings. Compact both cases before crossing the Node-API boundary.
        let compact_frontier = !input.retain_full_frontier
            && !input.allow_pre_ride_transfers
            && timetable_result
                .as_ref()
                .is_some_and(|result| result.status == "ready")
            && (1..=2).contains(&boarding_count)
            && selected_origin.is_some_and(|index| index < origin_candidate_count as usize)
            && selected_destination
                .is_some_and(|index| index < destination_candidate_count as usize);
        let compact_endpoints = if direct_walk_access_dominates {
            Some(CompactEndpointRouteResult::diagnostics_only(&endpoints))
        } else if compact_frontier {
            let origin = selected_origin.unwrap_or(0);
            let destination = selected_destination.unwrap_or(0);
            // These are the exact, freshly reconstructed access and egress
            // witnesses selected by the timetable. Returning them with the
            // compact result removes two later Node-API calls; it is not a
            // path cache and is scoped to this single query token.
            let origin_path_coordinates = self
                .materialize_path(MaterializePathInput {
                    query_token: endpoints.query_token,
                    role: "origin".to_owned(),
                    member_index: endpoints.origin_path_member_indices[origin],
                    maximum_points: 160,
                })?
                .coordinates;
            let destination_path_coordinates = self
                .materialize_path(MaterializePathInput {
                    query_token: endpoints.query_token,
                    role: "destination".to_owned(),
                    member_index: endpoints.destination_path_member_indices[destination],
                    maximum_points: 160,
                })?
                .coordinates;
            let compact = CompactEndpointRouteResult::from_full(
                &endpoints,
                origin,
                destination,
                origin_path_coordinates,
                destination_path_coordinates,
            );
            if let (Some(result), Some(step)) = (&mut timetable_result, selected_origin_step) {
                result.chain_trip_or_candidate[step] = 0;
                result.best_destination_index = Some(0);
            }
            Some(compact)
        } else {
            None
        };
        Ok(CoordinateTimetableResult {
            endpoints: (!(compact_frontier || direct_walk_access_dominates)).then_some(endpoints),
            compact_endpoints,
            timetable: timetable_result,
            arrive_by: arrive_by_result,
            direct_walk_cch_checked,
            direct_walk_distance_m,
            direct_walk_query_ns,
            direct_walk_path_checked,
            direct_walk_path,
            direct_walk_path_query_ns,
            direct_walk_access_dominates,
            compact_frontier,
            origin_candidate_count,
            destination_candidate_count,
            minimum_origin_access_seconds,
            minimum_destination_access_seconds,
            query_ns: started.elapsed().as_nanos() as f64,
            access_ns,
            timetable_ns,
            arrive_by_ns,
            forward_timetable_ns,
        })
    }

    /// Coordinate Matrix keeps endpoint frontiers and their timetable
    /// projection in Rust. It uses the same directed endpoint search and the
    /// same shared timetable scan as the separately exposed operations.
    #[napi]
    pub fn route_endpoints_timetable_matrix(
        &mut self,
        mut timetable: ClassInstance<'_, TimetableKernel>,
        input: CoordinateTimetableMatrixInput,
    ) -> napi::Result<CoordinateTimetableMatrixResult> {
        let started = Instant::now();
        let origin_count = input.origin_coordinates.len() / 2;
        let destination_count = input.destination_coordinates.len() / 2;
        let member_count = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?
            .member_lons
            .len();
        if origin_count == 0
            || destination_count == 0
            || !input.origin_coordinates.len().is_multiple_of(2)
            || !input.destination_coordinates.len().is_multiple_of(2)
            || origin_count > MAXIMUM_MATRIX_PAIRS / destination_count
            || input.member_timetable_stops.len() != member_count
            || input
                .origin_coordinates
                .chunks_exact(2)
                .chain(input.destination_coordinates.chunks_exact(2))
                .any(|point| {
                    !point[0].is_finite()
                        || !point[1].is_finite()
                        || point[0].abs() > 180.0
                        || point[1].abs() > 90.0
                })
        {
            return Err(Error::from_reason(
                "Coordinate Matrix requires valid coordinates, a matching stop projection, and at most 100,000 pairs.",
            ));
        }
        let mut project = |coordinates: &[f64],
                           role: &str|
         -> napi::Result<(Vec<u32>, Vec<u32>, Vec<f64>)> {
            let mut offsets = Vec::with_capacity(coordinates.len() / 2 + 1);
            let mut stops = Vec::new();
            let mut seconds = Vec::new();
            offsets.push(0);
            for point in coordinates.chunks_exact(2) {
                let access = self.route_endpoint(EndpointRoleInput {
                    longitude: point[0],
                    latitude: point[1],
                    role: role.to_owned(),
                    maximum_walk_m: input.maximum_walk_m,
                    walking_speed_kph: input.walking_speed_kph,
                    access_padding_factor: input.access_padding_factor,
                    access_overhead_seconds: input.access_overhead_seconds,
                    disable_cache: input.disable_cache,
                })?;
                for (&member, &walk) in access.member_indices.iter().zip(&access.access_seconds) {
                    let stop = input.member_timetable_stops[member as usize];
                    if stop != u32::MAX {
                        stops.push(stop);
                        seconds.push(f64::from(walk));
                    }
                }
                offsets.push(u32::try_from(stops.len()).map_err(|_| {
                    Error::from_reason(
                        "Coordinate Matrix endpoint frontier exceeds native index capacity.",
                    )
                })?);
            }
            Ok((offsets, stops, seconds))
        };
        let (destination_offsets, destination_stops, destination_walk_seconds) =
            project(&input.destination_coordinates, "destination")?;
        let (origin_offsets, origin_stops, origin_walk_seconds) =
            project(&input.origin_coordinates, "origin")?;
        let access_ns = started.elapsed().as_nanos() as f64;
        let result = timetable.route_matrix_csa(TimetableMatrixQueryInput {
            origin_offsets,
            origin_stops,
            origin_walk_seconds,
            destination_offsets,
            destination_stops,
            destination_walk_seconds,
            allow_pre_ride_transfers: vec![false; origin_count],
            allow_post_ride_transfers: Some(vec![false; destination_count]),
            departure: input.departure,
            horizon: input.horizon,
            arrive_by: input.arrive_by,
            maximum_boardings: input.maximum_boardings,
        })?;
        Ok(CoordinateTimetableMatrixResult {
            timetable: result,
            access_ns,
            query_ns: started.elapsed().as_nanos() as f64,
        })
    }

    /// One native boundary for Accessibility: exact coordinate-origin street
    /// access followed by one exact timetable scan to every requested stop.
    /// The timetable object is the same resident `TimetableKernel` instance
    /// used by scalar point and matrix queries.
    #[napi]
    pub fn route_endpoint_timetable_many(
        &mut self,
        mut timetable: ClassInstance<'_, TimetableKernel>,
        input: CoordinateTimetableManyInput,
    ) -> napi::Result<CoordinateTimetableManyResult> {
        let started = Instant::now();
        let member_count = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?
            .member_lons
            .len();
        if input.member_timetable_stops.len() != member_count
            || input.target_timetable_stops.is_empty()
        {
            return Err(Error::from_reason(
                "Coordinate one-to-many timetable projection or target arrays are inconsistent.",
            ));
        }

        let access_started = Instant::now();
        let access = self.route_endpoint(EndpointRoleInput {
            longitude: input.origin_lon,
            latitude: input.origin_lat,
            maximum_walk_m: input.maximum_walk_m,
            walking_speed_kph: input.walking_speed_kph,
            access_padding_factor: input.access_padding_factor,
            access_overhead_seconds: input.access_overhead_seconds,
            role: "origin".to_owned(),
            disable_cache: input.disable_cache,
        })?;
        let access_ns = access_started.elapsed().as_nanos() as f64;
        let origin_candidate_count = access.member_indices.len() as u32;
        let mut origin_stops = Vec::<u32>::with_capacity(access.member_indices.len());
        let mut origin_walk_seconds = Vec::<f64>::with_capacity(access.member_indices.len());
        for (&member, &walk_seconds) in access.member_indices.iter().zip(&access.access_seconds) {
            let stop = input.member_timetable_stops[member as usize];
            if stop == u32::MAX {
                continue;
            }
            origin_stops.push(stop);
            origin_walk_seconds.push(walk_seconds as f64);
        }
        let projected_origin_count = origin_stops.len() as u32;

        let target_count = input.target_timetable_stops.len();
        let destination_offsets = (0..=target_count as u32).collect::<Vec<_>>();
        let destination_stops = input.target_timetable_stops.to_vec();
        let destination_walk_seconds = vec![0.0; target_count];
        let timetable_started = Instant::now();
        let timetable_result = timetable.route_many_csa(TimetableManyQueryInput {
            origin_stops,
            origin_walk_seconds,
            destination_offsets,
            destination_stops,
            destination_walk_seconds,
            excluded_trips: input.excluded_trips.to_vec(),
            departure: input.departure,
            horizon: input.horizon,
            allow_pre_ride_transfers: input.allow_pre_ride_transfers,
            allow_post_ride_transfers: None,
            maximum_boardings: input.maximum_boardings,
        })?;
        let timetable_ns = timetable_started.elapsed().as_nanos() as f64;

        Ok(CoordinateTimetableManyResult {
            access,
            timetable: timetable_result,
            origin_candidate_count,
            projected_origin_count,
            target_count: target_count as u32,
            query_ns: started.elapsed().as_nanos() as f64,
            access_ns,
            timetable_ns,
        })
    }

    #[napi]
    pub fn clear_endpoint_caches(&mut self) {
        self.origin_cache.clear();
        self.origin_cache_order.clear();
        self.origin_cache_bytes = 0;
        self.destination_cache.clear();
        self.destination_cache_order.clear();
        self.destination_cache_bytes = 0;
        self.last_origin_frontier = None;
        self.last_destination_frontier = None;
        self.query_token = self.query_token.wrapping_add(1).max(1);
    }

    #[napi]
    pub fn reserve_endpoint_workspaces(
        &mut self,
        maximum_walk_m: f64,
    ) -> napi::Result<WorkspaceReservationResult> {
        if !maximum_walk_m.is_finite() || maximum_walk_m <= 0.0 {
            return Err(Error::from_reason(
                "maximumWalkM must be a positive finite number.",
            ));
        }
        let local_nodes = maximum_spatial_tile_len(&self.snapshot, maximum_walk_m)?;
        self.origin_workspace.reserve_local_len(local_nodes);
        self.destination_workspace.reserve_local_len(local_nodes);
        self.path_workspace.reserve_local_len(local_nodes);
        self.reverse_path_workspace.reserve_local_len(local_nodes);
        Ok(WorkspaceReservationResult {
            maximum_walk_m,
            local_nodes: local_nodes as u32,
            workspace_bytes: (self.origin_workspace.byte_length()
                + self.destination_workspace.byte_length()
                + self.path_workspace.byte_length()
                + self.reverse_path_workspace.byte_length()) as f64,
        })
    }

    /// Build and persist the metric-independent street CCH plus its walking
    /// distance metric. This is an offline/prewarm operation; endpoint queries
    /// only mmap the resulting immutable files.
    #[napi]
    pub fn build_street_cch_index(
        &self,
        input: StreetCchBuildInput,
    ) -> napi::Result<StreetCchBuildResult> {
        let total_started = Instant::now();
        let structure_path = Path::new(&input.structure_path);
        let metric_path = Path::new(&input.metric_path);
        if structure_path
            .parent()
            .is_none_or(|parent| !parent.is_dir())
            || metric_path.parent().is_none_or(|parent| !parent.is_dir())
        {
            return Err(Error::from_reason(
                "Street CCH destination directory does not exist.",
            ));
        }
        let edge_offsets = self.snapshot.u32_array("edgeOffsets")?;
        let edge_targets = self.snapshot.u32_array("edgeTargets")?;
        let edge_distances = self.snapshot.f64_array("edgeDistances")?;
        let node_lats = self.snapshot.f64_array("nodeLats")?;
        let node_lons = self.snapshot.f64_array("nodeLons")?;
        let maximum_representable_edge_m =
            (cch::INF_WEIGHT - 1) as f64 / CCH_DISTANCE_UNITS_PER_METER;
        if edge_distances.iter().any(|distance_m| {
            !distance_m.is_finite()
                || *distance_m < 0.0
                || *distance_m > maximum_representable_edge_m
        }) {
            return Err(Error::from_reason(format!(
                "Street CCH metric requires finite non-negative edges no longer than {maximum_representable_edge_m:.3} m.",
            )));
        }
        let graph = cch::graph::Graph {
            first_out: edge_offsets.to_vec(),
            head: edge_targets.to_vec(),
            weight: edge_distances
                .par_iter()
                .map(|distance_m| {
                    (distance_m * CCH_DISTANCE_UNITS_PER_METER)
                        .round()
                        .clamp(0.0, (cch::INF_WEIGHT - 1) as f64) as u32
                })
                .collect(),
        };
        let order_started = Instant::now();
        let order_strategy = input.order_strategy.as_deref().unwrap_or("inertial");
        let order = match order_strategy {
            "degree" => cch::degree_order(&graph),
            "inertial" => {
                let mut tail = Vec::with_capacity(edge_targets.len());
                for node in 0..self.snapshot.header.node_count {
                    tail.extend(std::iter::repeat_n(
                        node as u32,
                        edge_offsets[node + 1] as usize - edge_offsets[node] as usize,
                    ));
                }
                let latitudes = node_lats
                    .iter()
                    .map(|value| *value as f32)
                    .collect::<Vec<_>>();
                let longitudes = node_lons
                    .iter()
                    .map(|value| *value as f32)
                    .collect::<Vec<_>>();
                cch::inertial_order(
                    self.snapshot.header.node_count as u32,
                    &tail,
                    edge_targets,
                    &latitudes,
                    &longitudes,
                )
            }
            _ => {
                return Err(Error::from_reason(
                    "Street CCH orderStrategy must be inertial or degree.",
                ));
            }
        };
        let order_ns = order_started.elapsed().as_nanos() as f64;
        let structure_started = Instant::now();
        let cch = cch::Cch::build(&graph, &order);
        let structure_ns = structure_started.elapsed().as_nanos() as f64;
        let customization_started = Instant::now();
        let metric = cch.customize(&graph.weight);
        let customization_ns = customization_started.elapsed().as_nanos() as f64;
        let persistence_started = Instant::now();
        let temporary_structure = temporary_access_profile_path(structure_path);
        let temporary_metric = temporary_access_profile_path(metric_path);
        let persistence_result = (|| -> std::result::Result<(u64, u64), String> {
            cch.save_struct(&temporary_structure)
                .map_err(|error| error.to_string())?;
            metric
                .save(&temporary_metric)
                .map_err(|error| error.to_string())?;
            fs::rename(&temporary_structure, structure_path).map_err(|error| error.to_string())?;
            fs::rename(&temporary_metric, metric_path).map_err(|error| error.to_string())?;
            Ok((
                fs::metadata(structure_path)
                    .map_err(|error| error.to_string())?
                    .len(),
                fs::metadata(metric_path)
                    .map_err(|error| error.to_string())?
                    .len(),
            ))
        })();
        let (structure_bytes, metric_bytes) = match persistence_result {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = fs::remove_file(&temporary_structure);
                let _ = fs::remove_file(&temporary_metric);
                return Err(Error::from_reason(format!(
                    "Unable to persist street CCH index: {error}",
                )));
            }
        };
        Ok(StreetCchBuildResult {
            node_count: self.snapshot.header.node_count as u32,
            edge_count: self.snapshot.header.edge_count as u32,
            cch_arc_count: cch.cch_arc_count() as u32,
            distance_units_per_meter: CCH_DISTANCE_UNITS_PER_METER,
            order_ns,
            structure_ns,
            customization_ns,
            persistence_ns: persistence_started.elapsed().as_nanos() as f64,
            total_ns: total_started.elapsed().as_nanos() as f64,
            structure_bytes: structure_bytes as f64,
            metric_bytes: metric_bytes as f64,
        })
    }

    #[napi]
    pub fn load_street_cch_index(
        &mut self,
        input: StreetCchLoadInput,
    ) -> napi::Result<StreetCchLoadResult> {
        let started = Instant::now();
        let structure =
            cch::CchBundle::open(Path::new(&input.structure_path)).map_err(|error| {
                Error::from_reason(format!("Unable to mmap street CCH structure: {error}"))
            })?;
        let metric = cch::MetricBundle::open(Path::new(&input.metric_path)).map_err(|error| {
            Error::from_reason(format!("Unable to mmap street CCH metric: {error}"))
        })?;
        let structure_view = structure.view();
        let metric_view = metric.view();
        let node_count = structure_view.node_count() as usize;
        let cch_arc_count = structure_view.cch_arc_count() as usize;
        if node_count != self.snapshot.header.node_count
            || metric_view.forward.len() != cch_arc_count
            || metric_view.backward.len() != cch_arc_count
        {
            return Err(Error::from_reason(
                "Street CCH index does not match the active street snapshot.",
            ));
        }
        let forward_query = DynamicCchQuery::new(node_count);
        let reverse_query = DynamicCchQuery::new(node_count);
        let origin_member_workspace = CchMemberWorkspace::new();
        let destination_member_workspace = CchMemberWorkspace::new();
        let workspace_bytes = forward_query.byte_length()
            + reverse_query.byte_length()
            // PathQuery owns four u32 arrays plus a bit-packed membership
            // vector. Touched lists grow only with the elimination-tree search
            // space and are reported through process RSS by runtime diagnostics.
            + node_count * size_of::<u32>() * 4
            + node_count.div_ceil(8);
        self.street_cch = Some(StreetCchIndex {
            path_query: None,
            path_view: None,
            structure,
            metric,
            forward_query,
            reverse_query,
            origin_member_workspace,
            destination_member_workspace,
            origin_buckets: None,
            destination_buckets: None,
            bucket_build_ns: 0.0,
        });
        if let (Some(profile), Some(index)) = (&self.profile, &mut self.street_cch) {
            prepare_street_cch_target_buckets(profile, index)?;
        }
        // A cached exact-graph frontier and a CCH frontier have different path
        // witnesses. Never let one acceleration mode reuse the other's entry.
        self.clear_endpoint_caches();
        Ok(StreetCchLoadResult {
            node_count: node_count as u32,
            cch_arc_count: cch_arc_count as u32,
            distance_units_per_meter: CCH_DISTANCE_UNITS_PER_METER,
            workspace_bytes: workspace_bytes as f64,
            load_ns: started.elapsed().as_nanos() as f64,
        })
    }

    #[napi]
    pub fn probe_street_cch(
        &mut self,
        input: StreetCchProbeInput,
    ) -> napi::Result<StreetCchProbeResult> {
        let started = Instant::now();
        if input.source_nodes.len() != input.source_distances_m.len()
            || input.source_nodes.is_empty()
            || input.target_nodes.is_empty()
            || input
                .source_distances_m
                .iter()
                .any(|distance| !distance.is_finite() || *distance < 0.0)
        {
            return Err(Error::from_reason(
                "Street CCH probe sources or targets are inconsistent.",
            ));
        }
        let node_count = self.snapshot.header.node_count;
        if input
            .source_nodes
            .iter()
            .chain(input.target_nodes.iter())
            .any(|node| *node as usize >= node_count)
        {
            return Err(Error::from_reason(
                "Street CCH probe node is outside the active snapshot.",
            ));
        }
        let sources = input
            .source_nodes
            .iter()
            .copied()
            .zip(input.source_distances_m.iter().copied())
            .map(|(node, distance_m)| {
                (
                    node,
                    (distance_m * CCH_DISTANCE_UNITS_PER_METER)
                        .round()
                        .clamp(0.0, (cch::INF_WEIGHT - 1) as f64) as u32,
                )
            })
            .collect::<Vec<_>>();
        let index = self
            .street_cch
            .as_mut()
            .ok_or_else(|| Error::from_reason("Street CCH index is not loaded."))?;
        let StreetCchIndex {
            structure,
            metric,
            forward_query,
            reverse_query,
            ..
        } = index;
        let structure_view = structure.view();
        let metric_view = metric.view();
        let raw = if input.reverse.unwrap_or(false) {
            let reverse_metric = cch::bundle::MetricView {
                forward: metric_view.backward,
                backward: metric_view.forward,
            };
            reverse_query.distances(
                &structure_view,
                &reverse_metric,
                &sources,
                &input.target_nodes,
            )
        } else {
            forward_query.distances(&structure_view, &metric_view, &sources, &input.target_nodes)
        };
        let distances_m = raw
            .iter()
            .map(|distance| {
                if *distance == cch::INF_WEIGHT {
                    -1.0
                } else {
                    *distance as f64 / CCH_DISTANCE_UNITS_PER_METER
                }
            })
            .collect();
        Ok(StreetCchProbeResult {
            distances_m,
            query_ns: started.elapsed().as_nanos() as f64,
            source_count: sources.len() as u32,
            target_count: input.target_nodes.len() as u32,
        })
    }

    #[napi]
    pub fn street_surface(&self, input: StreetSurfaceInput) -> napi::Result<StreetSurfaceResult> {
        street_analysis::street_surface(
            &self.snapshot,
            self.snapshot.reciprocal_edge_flags(),
            input,
        )
    }

    #[napi]
    pub fn timed_connectors(
        &mut self,
        mut input: TimedConnectorInput,
    ) -> napi::Result<TimedConnectorResult> {
        let started = Instant::now();
        let (seed_count, target_count) = street_analysis::validate_timed_connector_input(&input)?;
        let target_coordinates = input.target_coordinates.clone();
        let include_target_matrix = input.include_target_matrix;
        let walk_speed_kph = input.walk_speed_kph;
        let maximum_duration_minutes = input.maximum_duration_minutes;
        let use_cch_aggregate = seed_count == 1 && self.street_cch.is_some();
        let use_cch_matrix = include_target_matrix && self.street_cch.is_some();
        let cch_targets = if use_cch_aggregate || use_cch_matrix {
            Some(prepare_cch_coordinate_targets(
                &self.snapshot,
                self.snapshot.reciprocal_edge_flags(),
                &target_coordinates,
            )?)
        } else {
            None
        };
        let minutes_per_meter = 60.0 / (walk_speed_kph * 1_000.0);
        let cch_aggregate = if use_cch_aggregate {
            let duration_limited_distance_m =
                (maximum_duration_minutes - input.seed_durations_minutes[0]) / minutes_per_meter;
            let maximum_distance_m = input.seed_maximum_walk_m[0]
                .min(duration_limited_distance_m)
                .max(0.0);
            let index = self.street_cch.as_mut().ok_or_else(|| {
                Error::from_reason("Street CCH disappeared before the aggregate connector query.")
            })?;
            let targets = cch_targets.as_ref().ok_or_else(|| {
                Error::from_reason("Street CCH aggregate targets were not prepared.")
            })?;
            Some(run_cch_coordinate_distances(
                &self.snapshot,
                self.snapshot.reciprocal_edge_flags(),
                index,
                targets,
                input.seed_coordinates[0],
                input.seed_coordinates[1],
                maximum_distance_m,
            )?)
        } else {
            None
        };
        let cch_matrix = if use_cch_matrix {
            let index = self.street_cch.as_mut().ok_or_else(|| {
                Error::from_reason("Street CCH disappeared before the connector matrix query.")
            })?;
            let targets = cch_targets.as_ref().ok_or_else(|| {
                Error::from_reason("Street CCH matrix targets were not prepared.")
            })?;
            Some(run_cch_coordinate_distance_matrix(
                index,
                targets,
                input.default_maximum_walk_m,
            )?)
        } else {
            None
        };

        let mut result = if let Some((mut distances_m, snapped_seeds, cch_query_ns)) = cch_aggregate
        {
            let seed_duration_minutes = input.seed_durations_minutes[0];
            let seed_index = input.seed_indices[0] as i32;
            let mut durations_minutes = vec![f64::INFINITY; target_count];
            let mut seed_indices = vec![-1; target_count];
            for target in 0..target_count {
                if !distances_m[target].is_finite() {
                    continue;
                }
                let duration_minutes =
                    seed_duration_minutes + distances_m[target] * minutes_per_meter;
                if duration_minutes > maximum_duration_minutes + 1e-9 {
                    distances_m[target] = f64::INFINITY;
                    continue;
                }
                durations_minutes[target] = duration_minutes;
                seed_indices[target] = seed_index;
            }
            let reached_targets = durations_minutes
                .iter()
                .filter(|duration| duration.is_finite())
                .count() as u32;
            TimedConnectorResult {
                durations_minutes,
                walk_distances_m: distances_m,
                seed_indices,
                matrix_durations_minutes: Vec::new(),
                matrix_walk_distances_m: Vec::new(),
                matrix_ready_pairs: 0,
                searches: 1_u32.saturating_add(if include_target_matrix {
                    target_count as u32
                } else {
                    0
                }),
                snapped_seeds,
                snapped_targets: cch_targets
                    .as_ref()
                    .map_or(0, |targets| targets.snapped_targets),
                reached_targets,
                settled_labels: 0,
                relaxed_edges: 0,
                retained_labels: 0,
                aggregate_cch_accelerated: true,
                aggregate_cch_query_ns: cch_query_ns,
                matrix_cch_accelerated: false,
                matrix_cch_query_ns: 0.0,
                query_ns: 0.0,
            }
        } else {
            if cch_matrix.is_some() {
                input.include_target_matrix = false;
            }
            street_analysis::timed_connectors(
                &self.snapshot,
                self.snapshot.reciprocal_edge_flags(),
                input,
            )?
        };
        if let Some((matrix_distances_m, _distance_ready_pairs, cch_query_ns)) = cch_matrix {
            result.matrix_walk_distances_m = matrix_distances_m;
            result.matrix_durations_minutes = result
                .matrix_walk_distances_m
                .iter()
                .map(|distance_m| {
                    let duration = *distance_m * minutes_per_meter;
                    if duration <= maximum_duration_minutes {
                        duration
                    } else {
                        f64::INFINITY
                    }
                })
                .collect();
            result.matrix_ready_pairs = result
                .matrix_durations_minutes
                .iter()
                .filter(|duration| duration.is_finite())
                .count() as u32;
            result.searches = 1_u32.saturating_add(target_count as u32);
            result.matrix_cch_accelerated = true;
            result.matrix_cch_query_ns = cch_query_ns;
        }
        if result.aggregate_cch_accelerated || result.matrix_cch_accelerated {
            result.query_ns = started.elapsed().as_nanos() as f64;
        }
        Ok(result)
    }

    #[napi]
    pub fn route_endpoint(&mut self, input: EndpointRoleInput) -> napi::Result<EndpointRoleResult> {
        if !input.maximum_walk_m.is_finite() || input.maximum_walk_m <= 0.0 {
            return Err(Error::from_reason(
                "maximumWalkM must be a positive finite number.",
            ));
        }
        let reverse_direction = match input.role.as_str() {
            "origin" => false,
            "destination" => true,
            _ => {
                return Err(Error::from_reason(
                    "Endpoint role must be origin or destination.",
                ));
            }
        };
        let profile = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?;
        let access_timing = AccessTiming::resolve(
            profile,
            input.walking_speed_kph,
            input.access_padding_factor,
            input.access_overhead_seconds,
        )?;
        let query_started = Instant::now();
        let disable_cache = input.disable_cache.unwrap_or(false);
        let cch = if input.maximum_walk_m <= CCH_MAXIMUM_QUERY_DISTANCE_M {
            self.street_cch.as_mut()
        } else {
            None
        };
        let result = match (cch, reverse_direction) {
            (Some(index), true) => cached_cch_frontier_search(
                &self.snapshot,
                self.terminal_access.as_ref(),
                self.snapshot.reciprocal_edge_flags(),
                &mut self.destination_workspace,
                &mut self.destination_snap_workspace,
                profile,
                &index.structure,
                &index.metric,
                &mut index.reverse_query,
                &mut index.destination_member_workspace,
                index.destination_buckets.as_ref(),
                &mut self.destination_cache,
                &mut self.destination_cache_order,
                &mut self.destination_cache_bytes,
                input.longitude,
                input.latitude,
                input.maximum_walk_m,
                true,
                disable_cache,
            )?,
            (Some(index), false) => cached_cch_frontier_search(
                &self.snapshot,
                self.terminal_access.as_ref(),
                self.snapshot.reciprocal_edge_flags(),
                &mut self.origin_workspace,
                &mut self.origin_snap_workspace,
                profile,
                &index.structure,
                &index.metric,
                &mut index.forward_query,
                &mut index.origin_member_workspace,
                index.origin_buckets.as_ref(),
                &mut self.origin_cache,
                &mut self.origin_cache_order,
                &mut self.origin_cache_bytes,
                input.longitude,
                input.latitude,
                input.maximum_walk_m,
                false,
                disable_cache,
            )?,
            (None, true) => cached_frontier_search(
                &self.snapshot,
                self.terminal_access.as_ref(),
                self.snapshot.reciprocal_edge_flags(),
                &mut self.destination_workspace,
                &mut self.destination_snap_workspace,
                profile,
                &mut self.destination_cache,
                &mut self.destination_cache_order,
                &mut self.destination_cache_bytes,
                input.longitude,
                input.latitude,
                input.maximum_walk_m,
                true,
                disable_cache,
            )?,
            (None, false) => cached_frontier_search(
                &self.snapshot,
                self.terminal_access.as_ref(),
                self.snapshot.reciprocal_edge_flags(),
                &mut self.origin_workspace,
                &mut self.origin_snap_workspace,
                profile,
                &mut self.origin_cache,
                &mut self.origin_cache_order,
                &mut self.origin_cache_bytes,
                input.longitude,
                input.latitude,
                input.maximum_walk_m,
                false,
                disable_cache,
            )?,
        };
        let access = reduce_access_frontier(
            profile,
            access_timing,
            &result.frontier,
            if reverse_direction {
                &mut self.destination_access_reduction_workspace
            } else {
                &mut self.origin_access_reduction_workspace
            },
            AccessEndpoint {
                longitude: input.longitude,
                latitude: input.latitude,
                maximum_walk_m: input.maximum_walk_m,
                origin_role: !reverse_direction,
            },
        );
        self.query_token = self.query_token.wrapping_add(1);
        if self.query_token == 0 {
            self.query_token = 1;
        }
        if reverse_direction {
            self.last_destination_frontier = Some(Arc::clone(&result.frontier));
        } else {
            self.last_origin_frontier = Some(Arc::clone(&result.frontier));
        }
        Ok(EndpointRoleResult {
            query_token: self.query_token,
            cache_hit: result.cache_hit,
            member_indices: access.member_indices,
            path_member_indices: access.path_member_indices,
            distances_m: access.distances_m,
            access_seconds: access.access_seconds,
            candidate_kinds: access.candidate_kinds,
            link_from_stop_keys: access.link_from_stop_keys,
            link_to_stop_keys: access.link_to_stop_keys,
            link_durations: access.link_durations,
            link_path_distances_m: access.link_path_distances_m,
            link_street_verified: access.link_street_verified,
            query_ns: query_started.elapsed().as_nanos() as f64,
            access_reduction_ns: access.reduction_ns,
            snap_ns: result.snap_ns,
            search_ns: result.search_ns,
            settled_nodes: result.frontier.settled_nodes,
            relaxed_edges: result.frontier.relaxed_edges,
            raw_candidates: result.frontier.member_indices.len() as u32,
            linked_stations: access.linked_stations,
            cch_accelerated: result.frontier.cch_accelerated,
        })
    }

    #[napi]
    pub fn materialize_path(
        &mut self,
        input: MaterializePathInput,
    ) -> napi::Result<MaterializePathResult> {
        if input.query_token != self.query_token {
            return Err(Error::from_reason(
                "Rust street predecessor token is stale; the route must be materialized before another coordinate query.",
            ));
        }
        let frontier = match input.role.as_str() {
            "origin" => self.last_origin_frontier.as_ref(),
            "destination" => self.last_destination_frontier.as_ref(),
            _ => {
                return Err(Error::from_reason(
                    "Rust street path role must be origin or destination.",
                ));
            }
        }
        .ok_or_else(|| Error::from_reason("Rust street path frontier is unavailable."))?
        .clone();
        let path = if frontier.cch_accelerated {
            let profile = self.profile.as_ref().ok_or_else(|| {
                Error::from_reason("Rust routing access profile is not configured.")
            })?;
            let member = input.member_index as usize;
            let Some(member_offset) = frontier
                .member_indices
                .iter()
                .position(|candidate| *candidate == input.member_index)
            else {
                return Err(Error::from_reason(
                    "Rust street path is unavailable for this stop label.",
                ));
            };
            if member >= profile.member_lons.len() {
                return Err(Error::from_reason(
                    "Rust street path member is outside the configured profile.",
                ));
            }
            let selected_source = frontier.source_terminals.get(member_offset).copied();
            let selected_target = frontier.terminals.get(member_offset).copied();
            let endpoint_snaps = selected_source
                .and_then(|node| {
                    frontier
                        .source_snaps
                        .iter()
                        .find(|snap| snap.node == node)
                        .copied()
                })
                .map_or_else(|| frontier.source_snaps.clone(), |snap| vec![snap]);
            let member_snaps = selected_target
                .and_then(|node| {
                    profile
                        .targets_for_node(node)
                        .iter()
                        .filter(|target| target.member as usize == member)
                        .min_by(|left, right| {
                            left.snap_distance_m.total_cmp(&right.snap_distance_m)
                        })
                        .map(|target| Snap {
                            node,
                            distance_m: target.snap_distance_m,
                        })
                })
                .map_or_else(|| profile.member_snap_frontier(member), |snap| vec![snap]);
            let member_coordinate = [profile.member_lons[member], profile.member_lats[member]];
            let endpoint_coordinate = [frontier.source_longitude, frontier.source_latitude];
            let exact = if frontier.reverse_direction {
                run_point_path(
                    &self.snapshot,
                    &mut self.path_workspace,
                    &mut self.reverse_path_workspace,
                    &member_snaps,
                    &endpoint_snaps,
                    [member_coordinate, endpoint_coordinate],
                    PointPathOptions {
                        maximum_distance_m: frontier.maximum_distance_m + 1.0,
                        contract_chains: true,
                    },
                )?
            } else {
                run_point_path(
                    &self.snapshot,
                    &mut self.path_workspace,
                    &mut self.reverse_path_workspace,
                    &endpoint_snaps,
                    &member_snaps,
                    [endpoint_coordinate, member_coordinate],
                    PointPathOptions {
                        maximum_distance_m: frontier.maximum_distance_m + 1.0,
                        contract_chains: true,
                    },
                )?
            }
            .ok_or_else(|| {
                Error::from_reason("Rust CCH street path witness could not be reconstructed.")
            })?;
            exact.nodes
        } else {
            frontier.path_for_member(&self.snapshot, input.member_index)?
        };
        let path = frontier.terminal_attachment.as_ref().map_or_else(
            || path.clone(),
            |a| a.extend_path(path.clone(), frontier.reverse_direction),
        );
        Ok(MaterializePathResult {
            coordinates: flatten_access_path(
                &self.snapshot,
                self.terminal_access.as_ref(),
                &path,
                input.maximum_points.max(2) as usize,
            )?,
        })
    }

    #[napi]
    pub fn route_path(&mut self, input: StreetPathInput) -> napi::Result<StreetPathResult> {
        if !input.maximum_distance_m.is_finite() || input.maximum_distance_m <= 0.0 {
            return Err(Error::from_reason(
                "maximumDistanceM must be a positive finite number.",
            ));
        }
        let started = Instant::now();
        // Generic point-to-point paths retain anonymous-coordinate semantics.
        // Public-anchor identity belongs to route_endpoints; applying it here
        // would silently reinterpret internal linked-station path requests.
        let origins = snaps_for_coordinate(
            &self.snapshot,
            self.snapshot.reciprocal_edge_flags(),
            input.origin_lon,
            input.origin_lat,
        )?;
        let destinations = snaps_for_coordinate(
            &self.snapshot,
            self.snapshot.reciprocal_edge_flags(),
            input.destination_lon,
            input.destination_lat,
        )?;
        let (origins, origin_access) = terminal_endpoint_snaps(
            &self.snapshot,
            self.terminal_access.as_ref(),
            origins,
            input.origin_lon,
            input.origin_lat,
            input.maximum_distance_m,
            false,
        )?;
        let (destinations, destination_access) = terminal_endpoint_snaps(
            &self.snapshot,
            self.terminal_access.as_ref(),
            destinations,
            input.destination_lon,
            input.destination_lat,
            input.maximum_distance_m,
            true,
        )?;
        let index = self.street_cch.as_mut().ok_or_else(|| {
            Error::from_reason("Rust pedestrian point routing requires a loaded current CCH index.")
        })?;
        let path = run_cch_point_path(
            &self.snapshot,
            index,
            &origins,
            &destinations,
            input.maximum_distance_m,
        )?;
        let path = finish_terminal_point_path(
            path,
            origin_access.as_deref(),
            destination_access.as_deref(),
            input.maximum_distance_m,
        );
        street_path_result(
            &self.snapshot,
            self.terminal_access.as_ref(),
            path,
            input.maximum_points,
            started,
        )
    }

    /// Compute a bounded directed coordinate matrix in one native call. The
    /// CCH query shares one destination frontier across every source row and
    /// returns scalar distances only; path geometry remains an explicit
    /// point-query concern.
    #[napi]
    pub fn route_street_matrix(
        &mut self,
        input: StreetMatrixInput,
    ) -> napi::Result<StreetMatrixResult> {
        let (origin_coordinate_pairs, origin_remainder) = input.origin_coordinates.as_chunks::<2>();
        let (destination_coordinate_pairs, destination_remainder) =
            input.destination_coordinates.as_chunks::<2>();
        let origin_count = origin_coordinate_pairs.len();
        let destination_count = destination_coordinate_pairs.len();
        if !origin_remainder.is_empty()
            || !destination_remainder.is_empty()
            || origin_count == 0
            || destination_count == 0
        {
            return Err(Error::from_reason(
                "Street matrix coordinates must contain non-empty longitude/latitude pairs.",
            ));
        }
        if origin_count.saturating_mul(destination_count) > MAXIMUM_MATRIX_PAIRS {
            return Err(Error::from_reason(
                "Street matrices are limited to 100,000 pairs.",
            ));
        }
        if input
            .origin_coordinates
            .iter()
            .chain(input.destination_coordinates.iter())
            .any(|coordinate| !coordinate.is_finite())
            || !input.maximum_distance_m.is_finite()
            || input.maximum_distance_m <= 0.0
        {
            return Err(Error::from_reason(
                "Street matrix coordinates or distance bound are inconsistent.",
            ));
        }

        let started = Instant::now();
        let reciprocal_edge_flags = self.snapshot.reciprocal_edge_flags();
        let origin_access = origin_coordinate_pairs
            .iter()
            .map(|pair| {
                let key = EndpointCacheKey::new(pair[0], pair[1], input.maximum_distance_m);
                if let Some(frontier) = self.origin_cache.get(&key)
                    && (!frontier.source_snaps.is_empty() || frontier.terminal_attachment.is_some())
                {
                    return Ok((
                        frontier.source_snaps.clone(),
                        frontier.terminal_attachment.clone(),
                    ));
                }
                terminal_endpoint_snaps(
                    &self.snapshot,
                    self.terminal_access.as_ref(),
                    snaps_for_coordinate(&self.snapshot, reciprocal_edge_flags, pair[0], pair[1])?,
                    pair[0],
                    pair[1],
                    input.maximum_distance_m,
                    false,
                )
            })
            .collect::<napi::Result<Vec<_>>>()?;
        let destination_access = destination_coordinate_pairs
            .iter()
            .map(|pair| {
                let key = EndpointCacheKey::new(pair[0], pair[1], input.maximum_distance_m);
                if let Some(frontier) = self.destination_cache.get(&key)
                    && (!frontier.source_snaps.is_empty() || frontier.terminal_attachment.is_some())
                {
                    return Ok((
                        frontier.source_snaps.clone(),
                        frontier.terminal_attachment.clone(),
                    ));
                }
                terminal_endpoint_snaps(
                    &self.snapshot,
                    self.terminal_access.as_ref(),
                    snaps_for_coordinate(&self.snapshot, reciprocal_edge_flags, pair[0], pair[1])?,
                    pair[0],
                    pair[1],
                    input.maximum_distance_m,
                    true,
                )
            })
            .collect::<napi::Result<Vec<_>>>()?;
        let origin_snaps: Vec<_> = origin_access
            .iter()
            .map(|(snaps, _)| snaps.clone())
            .collect();
        let destination_snaps: Vec<_> = destination_access
            .iter()
            .map(|(snaps, _)| snaps.clone())
            .collect();
        let reverse = origin_count > destination_count;
        let (target_coordinates, target_snaps, source_snaps) = if reverse {
            (&input.origin_coordinates, &origin_snaps, &destination_snaps)
        } else {
            (
                &input.destination_coordinates,
                &destination_snaps,
                &origin_snaps,
            )
        };
        let targets = cch_coordinate_targets_from_snap_sets(target_coordinates, target_snaps);
        let mut distances_m = vec![f64::INFINITY; origin_count * destination_count];
        let mut ready_pairs = 0_u32;
        let source_candidates = origin_snaps.iter().fold(0_u32, |count, snaps| {
            count.saturating_add(snaps.len() as u32)
        });
        let destination_candidates = destination_snaps.iter().fold(0_u32, |count, snaps| {
            count.saturating_add(snaps.len() as u32)
        });

        let Some(index) = self.street_cch.as_mut() else {
            return Err(Error::from_reason(
                "Rust street matrix routing requires a loaded current CCH index.",
            ));
        };
        let buckets = coordinate_matrix_buckets(
            index,
            &targets,
            source_snaps.len(),
            input.maximum_distance_m,
            reverse,
        )?;
        for (source, source_snap_set) in source_snaps.iter().enumerate() {
            let sources = source_snap_set
                .iter()
                .map(|snap| (snap.node, cch_distance_units(snap.distance_m)))
                .collect::<Vec<_>>();
            let row = cch_distances_to_coordinate_targets(
                index,
                &sources,
                &targets,
                input.maximum_distance_m,
                buckets.as_ref(),
                reverse,
            );
            for (target, distance) in row.iter().copied().enumerate() {
                let (origin, destination) = if reverse {
                    (target, source)
                } else {
                    (source, target)
                };
                let private_distance = origin_access[origin]
                    .1
                    .as_ref()
                    .and_then(|a| {
                        destination_access[destination]
                            .1
                            .as_ref()
                            .and_then(|b| a.direct_to(b))
                    })
                    .map_or(f64::INFINITY, |(d, _)| d);
                let distance = if private_distance <= input.maximum_distance_m {
                    distance.min(private_distance)
                } else {
                    distance
                };
                let matrix_index = origin * destination_count + destination;
                if input.origin_coordinates[origin * 2..origin * 2 + 2]
                    == input.destination_coordinates[destination * 2..destination * 2 + 2]
                {
                    distances_m[matrix_index] = 0.0;
                    ready_pairs = ready_pairs.saturating_add(1);
                } else if distance.is_finite() {
                    distances_m[matrix_index] = distance;
                    ready_pairs = ready_pairs.saturating_add(1);
                }
            }
        }

        Ok(StreetMatrixResult {
            distances_m,
            ready_pairs,
            source_candidates,
            destination_candidates,
            query_ns: started.elapsed().as_nanos() as f64,
            cch_accelerated: true,
            algorithm: "rust_cch_coordinate_distance_matrix_v1".to_owned(),
        })
    }

    #[napi]
    pub fn route_access_member_path(
        &mut self,
        input: AccessMemberPathInput,
    ) -> napi::Result<StreetPathResult> {
        if !input.maximum_distance_m.is_finite() || input.maximum_distance_m <= 0.0 {
            return Err(Error::from_reason(
                "maximumDistanceM must be a positive finite number.",
            ));
        }
        let profile = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?;
        let origin_member = input.origin_member_index as usize;
        let destination_member = input.destination_member_index as usize;
        if origin_member >= profile.member_lons.len()
            || destination_member >= profile.member_lons.len()
        {
            return Err(Error::from_reason(
                "Rust access member path indices are outside the configured profile.",
            ));
        }
        let started = Instant::now();
        let coordinate = |member: usize| {
            if input.stop_transfer.unwrap_or(false) {
                let stop = profile.member_stop_keys[member] as usize;
                [profile.stop_lons[stop], profile.stop_lats[stop]]
            } else {
                [profile.member_lons[member], profile.member_lats[member]]
            }
        };
        let origin = coordinate(origin_member);
        let destination = coordinate(destination_member);
        let snaps = |member, point: [f64; 2]| {
            if input.stop_transfer.unwrap_or(false) {
                snaps_for_coordinate(
                    &self.snapshot,
                    self.snapshot.reciprocal_edge_flags(),
                    point[0],
                    point[1],
                )
            } else {
                Ok(profile.member_snap_frontier(member))
            }
        };
        let origins = snaps(origin_member, origin)?;
        let destinations = snaps(destination_member, destination)?;
        let path = run_point_path(
            &self.snapshot,
            &mut self.path_workspace,
            &mut self.reverse_path_workspace,
            &origins,
            &destinations,
            [origin, destination],
            PointPathOptions {
                maximum_distance_m: input.maximum_distance_m,
                contract_chains: false,
            },
        )?;
        street_path_result(
            &self.snapshot,
            self.terminal_access.as_ref(),
            path,
            input.maximum_points,
            started,
        )
    }

    #[napi]
    pub fn build_stop_transfer_graph(
        &mut self,
        input: StopTransferGraphInput,
    ) -> napi::Result<StopTransferGraphResult> {
        if !input.maximum_walk_m.is_finite() || input.maximum_walk_m <= 0.0 {
            return Err(Error::from_reason(
                "maximumWalkM must be a positive finite number.",
            ));
        }
        // Zero is the production contract: retain every reachable local stop.
        // A positive cap remains available for explicitly bounded advanced
        // configurations.
        let maximum_neighbors = if input.maximum_neighbors == 0 {
            usize::MAX
        } else {
            input.maximum_neighbors.clamp(1, 4_096) as usize
        };
        let profile = self
            .profile
            .as_ref()
            .ok_or_else(|| Error::from_reason("Rust routing access profile is not configured."))?;
        let started = Instant::now();
        let mut edges = Vec::<(u32, u32, f64)>::new();
        let mut source_searches = 0_u32;
        let mut candidate_pairs = 0_u32;
        let mut settled_nodes = 0_u32;
        let mut relaxed_edges = 0_u32;

        for source in 0..profile.member_lons.len() {
            // A transfer begins where a passenger may alight and ends where a
            // passenger may board. These are the inverse endpoint roles used
            // by a point-to-transit query.
            if profile.member_destination_eligible[source] == 0 || !profile.member_has_snaps(source)
            {
                continue;
            }
            let longitude = profile.member_lons[source];
            let latitude = profile.member_lats[source];
            let targets =
                profile.members_in_radius(longitude, latitude, input.maximum_walk_m, true);
            if targets.is_empty() {
                continue;
            }
            let source_snaps = profile.member_snap_frontier(source);
            let routed = run_frontier_search(
                &self.snapshot,
                &mut self.origin_workspace,
                profile,
                &source_snaps,
                &targets,
                longitude,
                latitude,
                input.maximum_walk_m,
                false,
            )?;
            source_searches = source_searches.saturating_add(1);
            settled_nodes = settled_nodes.saturating_add(routed.settled_nodes);
            relaxed_edges = relaxed_edges.saturating_add(routed.relaxed_edges);
            let mut retained = 0_usize;
            for (&target, &distance_m) in
                routed.member_indices.iter().zip(routed.distances_m.iter())
            {
                if target as usize == source {
                    continue;
                }
                candidate_pairs = candidate_pairs.saturating_add(1);
                edges.push((source as u32, target, distance_m));
                retained += 1;
                if retained >= maximum_neighbors {
                    break;
                }
            }
        }

        edges.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| left.2.total_cmp(&right.2))
        });
        edges.dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
        let mut from_member_indices = Vec::with_capacity(edges.len());
        let mut to_member_indices = Vec::with_capacity(edges.len());
        let mut distances_m = Vec::with_capacity(edges.len());
        for (from, to, distance_m) in edges {
            from_member_indices.push(from);
            to_member_indices.push(to);
            distances_m.push(distance_m);
        }
        Ok(StopTransferGraphResult {
            from_member_indices,
            to_member_indices,
            distances_m,
            source_searches,
            candidate_pairs,
            settled_nodes,
            relaxed_edges,
            build_ns: started.elapsed().as_nanos() as f64,
        })
    }

    #[napi]
    pub fn diagnostics(&self) -> KernelDiagnostics {
        let profile_bytes = self
            .profile
            .as_ref()
            .map(AccessProfile::byte_length)
            .unwrap_or(0);
        let workspace_bytes = self.origin_workspace.byte_length()
            + self.destination_workspace.byte_length()
            + self.path_workspace.byte_length()
            + self.reverse_path_workspace.byte_length();
        let cch_resident_bytes = self.street_cch.as_ref().map_or(0, |index| {
            index.forward_query.byte_length()
                + index.reverse_query.byte_length()
                + index.origin_member_workspace.byte_length()
                + index.destination_member_workspace.byte_length()
                + index
                    .origin_buckets
                    .as_ref()
                    .map_or(0, CchTargetBuckets::byte_length)
                + index
                    .destination_buckets
                    .as_ref()
                    .map_or(0, CchTargetBuckets::byte_length)
        });
        KernelDiagnostics {
            snapshot_version: self.snapshot.header.version,
            snapshot_bytes: self.snapshot.mmap.len() as f64,
            node_count: self.snapshot.header.node_count as u32,
            edge_count: self.snapshot.header.edge_count as u32,
            reverse_edge_count: self.snapshot.header.edge_count as u32,
            reverse_graph_bytes: 0.0,
            workspace_bytes: (workspace_bytes + cch_resident_bytes) as f64,
            access_profile_bytes: profile_bytes as f64,
            native_resident_bytes: (workspace_bytes + cch_resident_bytes + profile_bytes) as f64,
        }
    }

    #[napi]
    pub fn profile_diagnostics(&self) -> ProfileDiagnostics {
        let endpoint_cache_entries = self.origin_cache.len() + self.destination_cache.len();
        let endpoint_cache_bytes = self.origin_cache_bytes + self.destination_cache_bytes;
        match &self.profile {
            Some(profile) => {
                let snapped_member_count = (0..profile.member_lons.len())
                    .filter(|member| profile.member_has_snaps(*member))
                    .count();
                let snap_count = profile.anchor_snaps.iter().map(Vec::len).sum::<usize>();
                let snap_reference_count = profile.snap_reference_count();
                let cch_bucket_entries = self.street_cch.as_ref().map_or(0, |index| {
                    index
                        .origin_buckets
                        .as_ref()
                        .map_or(0, |value| value.entries().len())
                        + index
                            .destination_buckets
                            .as_ref()
                            .map_or(0, |value| value.entries().len())
                });
                let cch_bucket_bytes = self.street_cch.as_ref().map_or(0, |index| {
                    index
                        .origin_buckets
                        .as_ref()
                        .map_or(0, CchTargetBuckets::byte_length)
                        + index
                            .destination_buckets
                            .as_ref()
                            .map_or(0, CchTargetBuckets::byte_length)
                });
                ProfileDiagnostics {
                    configured: true,
                    profile_key: Some(profile.key.clone()),
                    anchor_count: profile.anchor_lons.len() as u32,
                    member_count: profile.member_lons.len() as u32,
                    snapped_member_count: snapped_member_count as u32,
                    snap_count: snap_count as u32,
                    snap_reference_count: snap_reference_count as u32,
                    snap_storage_deduplication_ratio: if snap_count == 0 {
                        1.0
                    } else {
                        snap_reference_count as f64 / snap_count as f64
                    },
                    grid_cell_count: profile.grid_keys.len() as u32,
                    station_group_count: profile
                        .member_station_keys
                        .iter()
                        .copied()
                        .filter(|station| *station != NO_PROFILE_KEY)
                        .collect::<HashSet<_>>()
                        .len() as u32,
                    linked_access_edge_count: profile.linked_access.len() as u32,
                    cch_target_node_count: profile.target_nodes.len() as u32,
                    cch_bucket_entries: cch_bucket_entries as f64,
                    cch_bucket_bytes: cch_bucket_bytes as f64,
                    cch_bucket_build_ns: self
                        .street_cch
                        .as_ref()
                        .map_or(0.0, |index| index.bucket_build_ns),
                    estimated_bytes: profile.byte_length() as f64,
                    endpoint_cache_entries: endpoint_cache_entries as u32,
                    endpoint_cache_estimated_bytes: endpoint_cache_bytes as f64,
                    endpoint_cache_maximum_entries_per_role: MAXIMUM_ENDPOINT_CACHE_ENTRIES as u32,
                    endpoint_cache_maximum_bytes_per_role: MAXIMUM_ENDPOINT_CACHE_BYTES as f64,
                }
            }
            None => ProfileDiagnostics {
                configured: false,
                profile_key: None,
                anchor_count: 0,
                member_count: 0,
                snapped_member_count: 0,
                snap_count: 0,
                snap_reference_count: 0,
                snap_storage_deduplication_ratio: 1.0,
                grid_cell_count: 0,
                station_group_count: 0,
                linked_access_edge_count: 0,
                cch_target_node_count: 0,
                cch_bucket_entries: 0.0,
                cch_bucket_bytes: 0.0,
                cch_bucket_build_ns: 0.0,
                estimated_bytes: 0.0,
                endpoint_cache_entries: endpoint_cache_entries as u32,
                endpoint_cache_estimated_bytes: endpoint_cache_bytes as f64,
                endpoint_cache_maximum_entries_per_role: MAXIMUM_ENDPOINT_CACHE_ENTRIES as u32,
                endpoint_cache_maximum_bytes_per_role: MAXIMUM_ENDPOINT_CACHE_BYTES as f64,
            },
        }
    }
}

impl AccessProfile {
    fn members_in_radius(
        &self,
        longitude: f64,
        latitude: f64,
        maximum_distance_m: f64,
        origin_role: bool,
    ) -> Vec<u32> {
        let latitude_delta = maximum_distance_m / 1000.0 / 110.574;
        let longitude_delta =
            maximum_distance_m / 1000.0 / (111.32 * latitude.to_radians().cos().abs()).max(1.0);
        let minimum_latitude_cell =
            ((latitude - latitude_delta) / ACCESS_GRID_DEGREES).floor() as i32;
        let maximum_latitude_cell =
            ((latitude + latitude_delta) / ACCESS_GRID_DEGREES).floor() as i32;
        let minimum_longitude_cell =
            ((longitude - longitude_delta) / ACCESS_GRID_DEGREES).floor() as i32;
        let maximum_longitude_cell =
            ((longitude + longitude_delta) / ACCESS_GRID_DEGREES).floor() as i32;
        let mut members = Vec::new();
        for latitude_cell in minimum_latitude_cell..=maximum_latitude_cell {
            for longitude_cell in minimum_longitude_cell..=maximum_longitude_cell {
                for &anchor in self.anchors_in_cell(latitude_cell, longitude_cell) {
                    let anchor_index = anchor as usize;
                    if haversine_m(
                        longitude,
                        latitude,
                        self.anchor_lons[anchor_index],
                        self.anchor_lats[anchor_index],
                    ) > maximum_distance_m
                    {
                        continue;
                    }
                    let start = self.anchor_member_offsets[anchor_index] as usize;
                    let end = self.anchor_member_offsets[anchor_index + 1] as usize;
                    for &member in &self.anchor_member_indices[start..end] {
                        let member_index = member as usize;
                        let eligible = if origin_role {
                            self.member_origin_eligible[member_index] != 0
                        } else {
                            self.member_destination_eligible[member_index] != 0
                        };
                        if eligible && self.member_has_snaps(member_index) {
                            members.push(member);
                        }
                    }
                }
            }
        }
        members.sort_unstable();
        members.dedup();
        members
    }

    fn exact_members_at_coordinate(
        &self,
        longitude: f64,
        latitude: f64,
        origin_role: bool,
    ) -> Vec<u32> {
        let latitude_cell = (latitude / ACCESS_GRID_DEGREES).floor() as i32;
        let longitude_cell = (longitude / ACCESS_GRID_DEGREES).floor() as i32;
        let mut members = Vec::new();
        for &anchor in self.anchors_in_cell(latitude_cell, longitude_cell) {
            let anchor = anchor as usize;
            if self.anchor_lons[anchor] != longitude || self.anchor_lats[anchor] != latitude {
                continue;
            }
            let start = self.anchor_member_offsets[anchor] as usize;
            let end = self.anchor_member_offsets[anchor + 1] as usize;
            for &member in &self.anchor_member_indices[start..end] {
                let member_index = member as usize;
                let eligible = if origin_role {
                    self.member_origin_eligible[member_index] != 0
                } else {
                    self.member_destination_eligible[member_index] != 0
                };
                if eligible {
                    members.push(member);
                }
            }
        }
        members.sort_unstable();
        members.dedup();
        members
    }
}

fn insert_frontier_cache(
    cache: &mut HashMap<EndpointCacheKey, Arc<FrontierSearch>>,
    order: &mut VecDeque<EndpointCacheKey>,
    cache_bytes: &mut usize,
    key: EndpointCacheKey,
    value: Arc<FrontierSearch>,
) {
    let value_bytes = value.byte_length();
    if value_bytes > MAXIMUM_ENDPOINT_CACHE_BYTES {
        return;
    }
    if let Some(cached) = cache.get_mut(&key) {
        *cache_bytes = cache_bytes.saturating_sub(cached.byte_length()) + value_bytes;
        *cached = value;
        return;
    }
    while cache.len() >= MAXIMUM_ENDPOINT_CACHE_ENTRIES
        || cache_bytes.saturating_add(value_bytes) > MAXIMUM_ENDPOINT_CACHE_BYTES
    {
        let Some(oldest) = order.pop_front() else {
            break;
        };
        if let Some(removed) = cache.remove(&oldest) {
            *cache_bytes = cache_bytes.saturating_sub(removed.byte_length());
        }
    }
    cache.insert(key, value);
    order.push_back(key);
    *cache_bytes = cache_bytes.saturating_add(value_bytes);
}

struct CachedFrontier {
    frontier: Arc<FrontierSearch>,
    cache_hit: bool,
    snap_ns: f64,
    search_ns: f64,
}

fn prepare_street_cch_target_buckets(
    profile: &AccessProfile,
    index: &mut StreetCchIndex,
) -> napi::Result<()> {
    let started = Instant::now();
    let structure = index.structure.view();
    let metric = index.metric.view();
    let maximum_distance = (CCH_MAXIMUM_QUERY_DISTANCE_M * CCH_DISTANCE_UNITS_PER_METER)
        .round()
        .min((cch::INF_WEIGHT - 1) as f64) as u32;
    let (origin, destination) = rayon::join(
        || {
            build_cch_target_buckets(
                &structure,
                metric.backward,
                &profile.target_nodes,
                maximum_distance,
            )
        },
        || {
            build_cch_target_buckets(
                &structure,
                metric.forward,
                &profile.target_nodes,
                maximum_distance,
            )
        },
    );
    index.origin_buckets = Some(origin?);
    index.destination_buckets = Some(destination?);
    index.bucket_build_ns = started.elapsed().as_nanos() as f64;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cached_frontier_search(
    snapshot: &Snapshot,
    terminal_access: Option<&TerminalAccessGraph>,
    reciprocal_edge_flags: &[u8],
    workspace: &mut TileWorkspace,
    snap_workspace: &mut SnapWorkspace,
    profile: &AccessProfile,
    cache: &mut HashMap<EndpointCacheKey, Arc<FrontierSearch>>,
    order: &mut VecDeque<EndpointCacheKey>,
    cache_bytes: &mut usize,
    longitude: f64,
    latitude: f64,
    maximum_walk_m: f64,
    reverse_direction: bool,
    disable_cache: bool,
) -> napi::Result<CachedFrontier> {
    let key = EndpointCacheKey::new(longitude, latitude, maximum_walk_m);
    if !disable_cache && let Some(frontier) = cache.get(&key).cloned() {
        return Ok(CachedFrontier {
            frontier,
            cache_hit: true,
            snap_ns: 0.0,
            search_ns: 0.0,
        });
    }
    let snap_started = Instant::now();
    let snaps = snaps_for_coordinate_with_workspace(
        snapshot,
        reciprocal_edge_flags,
        snap_workspace,
        longitude,
        latitude,
    )?;
    let (snaps, attachment) = terminal_endpoint_snaps(
        snapshot,
        terminal_access,
        snaps,
        longitude,
        latitude,
        maximum_walk_m,
        reverse_direction,
    )?;
    let members =
        profile.members_in_radius(longitude, latitude, maximum_walk_m, !reverse_direction);
    let snap_ns = snap_started.elapsed().as_nanos() as f64;
    let search_started = Instant::now();
    let mut frontier = Arc::new(run_frontier_search(
        snapshot,
        workspace,
        profile,
        &snaps,
        &members,
        longitude,
        latitude,
        maximum_walk_m,
        reverse_direction,
    )?);
    Arc::get_mut(&mut frontier)
        .expect("new frontier")
        .terminal_attachment = attachment;
    let search_ns = search_started.elapsed().as_nanos() as f64;
    if !disable_cache {
        insert_frontier_cache(cache, order, cache_bytes, key, Arc::clone(&frontier));
    }
    Ok(CachedFrontier {
        frontier,
        cache_hit: false,
        snap_ns,
        search_ns,
    })
}

#[allow(clippy::too_many_arguments)]
fn cached_cch_frontier_search(
    snapshot: &Snapshot,
    terminal_access: Option<&TerminalAccessGraph>,
    reciprocal_edge_flags: &[u8],
    workspace: &mut TileWorkspace,
    snap_workspace: &mut SnapWorkspace,
    profile: &AccessProfile,
    structure: &cch::CchBundle,
    metric: &cch::MetricBundle,
    query: &mut DynamicCchQuery,
    member_workspace: &mut CchMemberWorkspace,
    buckets: Option<&CchTargetBuckets>,
    cache: &mut HashMap<EndpointCacheKey, Arc<FrontierSearch>>,
    order: &mut VecDeque<EndpointCacheKey>,
    cache_bytes: &mut usize,
    longitude: f64,
    latitude: f64,
    maximum_walk_m: f64,
    reverse_direction: bool,
    disable_cache: bool,
) -> napi::Result<CachedFrontier> {
    let key = EndpointCacheKey::new(longitude, latitude, maximum_walk_m);
    if !disable_cache && let Some(frontier) = cache.get(&key).cloned() {
        return Ok(CachedFrontier {
            frontier,
            cache_hit: true,
            snap_ns: 0.0,
            search_ns: 0.0,
        });
    }
    let snap_started = Instant::now();
    let snaps = snaps_for_coordinate_with_workspace(
        snapshot,
        reciprocal_edge_flags,
        snap_workspace,
        longitude,
        latitude,
    )?;
    let (snaps, attachment) = terminal_endpoint_snaps(
        snapshot,
        terminal_access,
        snaps,
        longitude,
        latitude,
        maximum_walk_m,
        reverse_direction,
    )?;
    let members = if buckets.is_some() {
        Vec::new()
    } else {
        profile.members_in_radius(longitude, latitude, maximum_walk_m, !reverse_direction)
    };
    let snap_ns = snap_started.elapsed().as_nanos() as f64;
    let search_started = Instant::now();
    let mut frontier = Arc::new(if let Some(buckets) = buckets {
        run_cch_bucket_frontier_search(
            profile,
            structure,
            metric,
            query,
            member_workspace,
            buckets,
            &snaps,
            longitude,
            latitude,
            maximum_walk_m,
            reverse_direction,
        )?
    } else {
        run_cch_frontier_search(
            snapshot,
            workspace,
            profile,
            structure,
            metric,
            query,
            &snaps,
            &members,
            longitude,
            latitude,
            maximum_walk_m,
            reverse_direction,
        )?
    });
    Arc::get_mut(&mut frontier)
        .expect("new frontier")
        .terminal_attachment = attachment;
    let search_ns = search_started.elapsed().as_nanos() as f64;
    if !disable_cache {
        insert_frontier_cache(cache, order, cache_bytes, key, Arc::clone(&frontier));
    }
    Ok(CachedFrontier {
        frontier,
        cache_hit: false,
        snap_ns,
        search_ns,
    })
}

fn access_cell(latitude: f64, longitude: f64) -> (i32, i32) {
    (
        (latitude / ACCESS_GRID_DEGREES).floor() as i32,
        (longitude / ACCESS_GRID_DEGREES).floor() as i32,
    )
}

fn access_cell_key(latitude_cell: i32, longitude_cell: i32) -> u64 {
    ((latitude_cell as u32 as u64) << 32) | longitude_cell as u32 as u64
}

fn haversine_m(left_lon: f64, left_lat: f64, right_lon: f64, right_lat: f64) -> f64 {
    let latitude_delta = (right_lat - left_lat).to_radians();
    let longitude_delta = (right_lon - left_lon).to_radians();
    let left_latitude = left_lat.to_radians();
    let right_latitude = right_lat.to_radians();
    let value = (latitude_delta / 2.0).sin().powi(2)
        + left_latitude.cos() * right_latitude.cos() * (longitude_delta / 2.0).sin().powi(2);
    EARTH_RADIUS_M * 2.0 * value.sqrt().atan2((1.0 - value).sqrt())
}

fn spatial_tile_ranges(
    snapshot: &Snapshot,
    longitude: f64,
    latitude: f64,
    maximum_distance_m: f64,
) -> napi::Result<Vec<TileRange>> {
    let spatial_offsets = snapshot.u32_array("spatialOffsets")?;
    let maximum_distance_km = maximum_distance_m / 1000.0;
    let latitude_delta = maximum_distance_km / 110.574;
    let longitude_delta =
        maximum_distance_km / (111.32 * latitude.to_radians().cos().abs()).max(1.0);
    let minimum_row = (((latitude - latitude_delta - snapshot.header.spatial_min_lat)
        / snapshot.header.spatial_cell_degrees)
        .floor()
        .max(0.0) as usize)
        .saturating_sub(1);
    let maximum_row = ((((latitude + latitude_delta - snapshot.header.spatial_min_lat)
        / snapshot.header.spatial_cell_degrees)
        .floor()
        .min(snapshot.header.spatial_rows.saturating_sub(1) as f64)
        .max(-1.0) as isize)
        + 1)
    .min(snapshot.header.spatial_rows as isize - 1);
    let minimum_column = (((longitude - longitude_delta - snapshot.header.spatial_min_lon)
        / snapshot.header.spatial_cell_degrees)
        .floor()
        .max(0.0) as usize)
        .saturating_sub(1);
    let maximum_column = ((((longitude + longitude_delta - snapshot.header.spatial_min_lon)
        / snapshot.header.spatial_cell_degrees)
        .floor()
        .min(snapshot.header.spatial_columns.saturating_sub(1) as f64)
        .max(-1.0) as isize)
        + 1)
    .min(snapshot.header.spatial_columns as isize - 1);
    if maximum_row < minimum_row as isize || maximum_column < minimum_column as isize {
        return Ok(Vec::new());
    }
    // Node ids follow cell order. One contiguous row slab keeps the hot inner
    // loop at a subtraction instead of a range lookup while still bounding
    // scratch to the endpoint's latitude tile rather than the national graph.
    let first_cell = minimum_row * snapshot.header.spatial_columns + minimum_column;
    let last_cell =
        maximum_row as usize * snapshot.header.spatial_columns + maximum_column as usize;
    let global_start = spatial_offsets[first_cell];
    let global_end = spatial_offsets[last_cell + 1];
    Ok((global_end > global_start)
        .then_some(TileRange {
            global_start,
            global_end,
            local_start: 0,
        })
        .into_iter()
        .collect())
}

fn maximum_spatial_tile_len(snapshot: &Snapshot, maximum_distance_m: f64) -> napi::Result<usize> {
    let spatial_offsets = snapshot.u32_array("spatialOffsets")?;
    let radius_degrees = (maximum_distance_m + RECOVERY_SNAP_RADIUS_M) / 1000.0 / 110.574;
    let row_span = ((radius_degrees / snapshot.header.spatial_cell_degrees).ceil() as usize)
        .saturating_mul(2)
        .saturating_add(3)
        .min(snapshot.header.spatial_rows);
    let mut maximum = 0_usize;
    for first_row in 0..snapshot.header.spatial_rows {
        let end_row = (first_row + row_span).min(snapshot.header.spatial_rows);
        let start = spatial_offsets[first_row * snapshot.header.spatial_columns] as usize;
        let end = spatial_offsets[end_row * snapshot.header.spatial_columns] as usize;
        maximum = maximum.max(end.saturating_sub(start));
    }
    Ok(maximum)
}

fn nodes_in_radius(
    snapshot: &Snapshot,
    longitude: f64,
    latitude: f64,
    maximum_distance_m: f64,
    mut candidates: Vec<Snap>,
) -> napi::Result<Vec<Snap>> {
    let node_lats = snapshot.f64_array("nodeLats")?;
    let node_lons = snapshot.f64_array("nodeLons")?;
    let spatial_offsets = snapshot.u32_array("spatialOffsets")?;
    let maximum_distance_km = maximum_distance_m / 1000.0;
    let latitude_delta = maximum_distance_km / 110.574;
    let longitude_delta =
        maximum_distance_km / (111.32 * latitude.to_radians().cos().abs()).max(1.0);
    let minimum_row = ((latitude - latitude_delta - snapshot.header.spatial_min_lat)
        / snapshot.header.spatial_cell_degrees)
        .floor()
        .max(0.0) as usize;
    let maximum_row = ((latitude + latitude_delta - snapshot.header.spatial_min_lat)
        / snapshot.header.spatial_cell_degrees)
        .floor()
        .min(snapshot.header.spatial_rows.saturating_sub(1) as f64)
        .max(-1.0) as isize;
    let minimum_column = ((longitude - longitude_delta - snapshot.header.spatial_min_lon)
        / snapshot.header.spatial_cell_degrees)
        .floor()
        .max(0.0) as usize;
    let maximum_column = ((longitude + longitude_delta - snapshot.header.spatial_min_lon)
        / snapshot.header.spatial_cell_degrees)
        .floor()
        .min(snapshot.header.spatial_columns.saturating_sub(1) as f64)
        .max(-1.0) as isize;
    if maximum_row < minimum_row as isize || maximum_column < minimum_column as isize {
        candidates.clear();
        return Ok(candidates);
    }
    let latitude_limit_radians = (latitude.to_radians().abs()
        + maximum_distance_m / EARTH_RADIUS_M)
        .min(std::f64::consts::FRAC_PI_2);
    let longitude_lower_bound_scale = latitude_limit_radians.cos().max(0.0);
    let earth_radius_squared_m = EARTH_RADIUS_M * EARTH_RADIUS_M;
    let maximum_distance_squared_m = maximum_distance_m * maximum_distance_m;
    candidates.clear();
    for row in minimum_row..=maximum_row as usize {
        for column in minimum_column..=maximum_column as usize {
            let cell = row * snapshot.header.spatial_columns + column;
            let start = spatial_offsets[cell] as usize;
            let end = spatial_offsets[cell + 1] as usize;
            for node in start..end {
                let node_latitude = node_lats[node];
                let node_longitude = node_lons[node];
                if node_latitude < latitude - latitude_delta
                    || node_latitude > latitude + latitude_delta
                    || node_longitude < longitude - longitude_delta
                    || node_longitude > longitude + longitude_delta
                {
                    continue;
                }
                // This scaled equirectangular metric is a lower bound on the
                // spherical distance throughout the bounded latitude band.
                // Reject the square's corner nodes before paying for the full
                // haversine while preserving the exact snap frontier.
                let latitude_radians = (node_latitude - latitude).to_radians();
                let longitude_radians = (node_longitude - longitude).to_radians().abs();
                let wrapped_longitude_radians = if longitude_radians > std::f64::consts::PI {
                    std::f64::consts::TAU - longitude_radians
                } else {
                    longitude_radians
                };
                let scaled_longitude_radians =
                    longitude_lower_bound_scale * wrapped_longitude_radians;
                let lower_bound_squared_m = earth_radius_squared_m
                    * (latitude_radians * latitude_radians
                        + scaled_longitude_radians * scaled_longitude_radians);
                if lower_bound_squared_m > maximum_distance_squared_m {
                    continue;
                }
                let distance_m = haversine_m(longitude, latitude, node_longitude, node_latitude);
                if distance_m <= maximum_distance_m {
                    candidates.push(Snap {
                        node: node as u32,
                        distance_m,
                    });
                }
            }
        }
    }
    candidates.sort_by(|left, right| {
        left.distance_m
            .total_cmp(&right.distance_m)
            .then_with(|| left.node.cmp(&right.node))
    });
    Ok(candidates)
}

fn reciprocal_edge_snaps(
    snapshot: &Snapshot,
    reciprocal_edge_flags: &[u8],
    ordered_nodes: &[Snap],
    ordered_by_node: &[Snap],
    coordinate: [f64; 2],
    evaluated_from_nodes: &mut IntegerHashSet<u32>,
    mut snaps: Vec<ReciprocalEdgeSnap>,
) -> napi::Result<Vec<ReciprocalEdgeSnap>> {
    let [longitude, latitude] = coordinate;
    let offsets = snapshot.u32_array("edgeOffsets")?;
    let targets = snapshot.u32_array("edgeTargets")?;
    let distances = snapshot.f64_array("edgeDistances")?;
    let lats = snapshot.f64_array("nodeLats")?;
    let lons = snapshot.f64_array("nodeLons")?;
    let longitude_scale = 111.32 * latitude.to_radians().cos();
    snaps.clear();
    for candidate in ordered_nodes {
        let left = candidate.node;
        for edge in offsets[left as usize] as usize..offsets[left as usize + 1] as usize {
            let right = targets[edge];
            // Preserve the established closest-endpoint orientation. Once
            // the other endpoint has been visited, this reciprocal edge was
            // evaluated.
            if evaluated_from_nodes.contains(&right) {
                continue;
            }
            if reciprocal_edge_flags[edge] == 0 {
                continue;
            }
            let left_x = (lons[left as usize] - longitude) * longitude_scale;
            let left_y = (lats[left as usize] - latitude) * 110.574;
            let right_x = (lons[right as usize] - longitude) * longitude_scale;
            let right_y = (lats[right as usize] - latitude) * 110.574;
            let edge_x = right_x - left_x;
            let edge_y = right_y - left_y;
            let edge_length_squared = edge_x * edge_x + edge_y * edge_y;
            if edge_length_squared <= 0.0 {
                continue;
            }
            let projection = -(left_x * edge_x + left_y * edge_y) / edge_length_squared;
            if !(0.0..=1.0).contains(&projection) {
                continue;
            }
            let projection_x = left_x + projection * edge_x;
            let projection_y = left_y + projection * edge_y;
            let projection_distance_m =
                (projection_x * projection_x + projection_y * projection_y).sqrt() * 1000.0;
            if projection_distance_m > SNAP_RADIUS_M {
                continue;
            }
            if ordered_by_node
                .binary_search_by_key(&right, |snap| snap.node)
                .is_err()
            {
                continue;
            }
            let edge_distance_m = distances[edge];
            snaps.push(ReciprocalEdgeSnap {
                left: Snap {
                    node: left,
                    distance_m: projection_distance_m + projection * edge_distance_m,
                },
                right: Snap {
                    node: right,
                    distance_m: projection_distance_m + (1.0 - projection) * edge_distance_m,
                },
                projection_distance_m,
            });
        }
        evaluated_from_nodes.insert(left);
    }
    Ok(snaps)
}

fn snaps_for_coordinate(
    snapshot: &Snapshot,
    reciprocal_edge_flags: &[u8],
    longitude: f64,
    latitude: f64,
) -> napi::Result<Vec<Snap>> {
    snaps_for_coordinate_with_workspace(
        snapshot,
        reciprocal_edge_flags,
        &mut SnapWorkspace::default(),
        longitude,
        latitude,
    )
}

fn snaps_for_coordinate_with_workspace(
    snapshot: &Snapshot,
    reciprocal_edge_flags: &[u8],
    workspace: &mut SnapWorkspace,
    longitude: f64,
    latitude: f64,
) -> napi::Result<Vec<Snap>> {
    if !longitude.is_finite() || !latitude.is_finite() {
        return Err(Error::from_reason(
            "Coordinate longitude and latitude must be finite.",
        ));
    }
    let ordered = nodes_in_radius(
        snapshot,
        longitude,
        latitude,
        RECOVERY_SNAP_RADIUS_M,
        std::mem::take(&mut workspace.candidate_nodes),
    )?;
    if ordered.is_empty() {
        workspace.candidate_nodes = ordered;
        return Ok(Vec::new());
    }
    workspace.begin(ordered.len());
    workspace.ordered_by_node.extend_from_slice(&ordered);
    workspace
        .ordered_by_node
        .sort_unstable_by_key(|snap| snap.node);
    let projected = reciprocal_edge_snaps(
        snapshot,
        reciprocal_edge_flags,
        &ordered,
        &workspace.ordered_by_node,
        [longitude, latitude],
        &mut workspace.evaluated_from_nodes,
        std::mem::take(&mut workspace.projected_edges),
    )?;
    let nearest = ordered[0];
    let edge = projected.iter().min_by(|left, right| {
        left.projection_distance_m
            .total_cmp(&right.projection_distance_m)
            .then_with(|| {
                (
                    left.left.node.min(left.right.node),
                    left.left.node.max(left.right.node),
                )
                    .cmp(&(
                        right.left.node.min(right.right.node),
                        right.left.node.max(right.right.node),
                    ))
            })
    });
    let mut selected = match edge {
        Some(edge) if edge.projection_distance_m < nearest.distance_m => {
            vec![edge.left, edge.right]
        }
        _ => vec![nearest],
    };
    // Every physical coordinate has one fixed street attachment, including
    // transit stops. Multiple nearby components cannot be joined through a
    // stop connector that ordinary walking cannot traverse.
    // The nearest vertex wins an exact tie with a projected reciprocal edge.
    selected.sort_by(|left, right| {
        left.distance_m
            .total_cmp(&right.distance_m)
            .then_with(|| left.node.cmp(&right.node))
    });
    selected.dedup_by_key(|snap| snap.node);
    workspace.candidate_nodes = ordered;
    workspace.projected_edges = projected;
    Ok(selected)
}

struct FrontierTargets {
    members: Vec<u32>,
    target_nodes: Vec<u32>,
    minimum_snap_by_member: Vec<f64>,
    unresolved_member_offsets: Vec<u32>,
}

#[allow(clippy::too_many_arguments)]
fn run_cch_bucket_frontier_search(
    profile: &AccessProfile,
    structure: &cch::CchBundle,
    metric: &cch::MetricBundle,
    query: &mut DynamicCchQuery,
    member_workspace: &mut CchMemberWorkspace,
    buckets: &CchTargetBuckets,
    source_snaps: &[Snap],
    source_longitude: f64,
    source_latitude: f64,
    maximum_distance_m: f64,
    reverse_direction: bool,
) -> napi::Result<FrontierSearch> {
    if source_snaps.is_empty() {
        return Ok(FrontierSearch {
            member_indices: Vec::new(),
            distances_m: Vec::new(),
            terminals: Vec::new(),
            source_terminals: Vec::new(),
            source_snaps: Vec::new(),
            terminal_attachment: None,
            predecessors: Vec::new(),
            reverse_direction,
            source_longitude,
            source_latitude,
            maximum_distance_m,
            cch_accelerated: true,
            settled_nodes: 0,
            relaxed_edges: 0,
        });
    }
    let maximum_distance = (maximum_distance_m * CCH_DISTANCE_UNITS_PER_METER)
        .round()
        .min((cch::INF_WEIGHT - 1) as f64) as u32;
    if maximum_distance > buckets.maximum_distance {
        return Err(Error::from_reason(
            "Street CCH target buckets do not cover the requested walk limit.",
        ));
    }
    let sources = source_snaps
        .iter()
        .map(|snap| {
            (
                snap.node,
                (snap.distance_m * CCH_DISTANCE_UNITS_PER_METER)
                    .round()
                    .clamp(0.0, (cch::INF_WEIGHT - 1) as f64) as u32,
            )
        })
        .collect::<Vec<_>>();
    let structure_view = structure.view();
    let metric_view = metric.view();
    let forward_weights = if reverse_direction {
        metric_view.backward
    } else {
        metric_view.forward
    };
    let (target_indices, graph_distances, graph_sources) = query.range_targets(
        &structure_view,
        forward_weights,
        buckets,
        &sources,
        maximum_distance,
        profile.target_nodes.len(),
    );
    let member_generation = member_workspace.begin(profile.member_lons.len());
    for ((&target_index, &graph_distance), &graph_source) in target_indices
        .iter()
        .zip(graph_distances)
        .zip(graph_sources)
    {
        let target_index = target_index as usize;
        let node = profile.target_nodes[target_index];
        let start = profile.target_offsets[target_index] as usize;
        let end = profile.target_offsets[target_index + 1] as usize;
        for target in &profile.targets[start..end] {
            let member = target.member as usize;
            let eligible = if reverse_direction {
                profile.member_destination_eligible[member] != 0
            } else {
                profile.member_origin_eligible[member] != 0
            };
            if !eligible {
                continue;
            }
            let target_snap = (target.snap_distance_m * CCH_DISTANCE_UNITS_PER_METER)
                .round()
                .clamp(0.0, (cch::INF_WEIGHT - 1) as f64) as u32;
            let total = graph_distance.saturating_add(target_snap);
            if total > maximum_distance
                || (member_workspace.generations[member] == member_generation
                    && total >= member_workspace.distances[member])
            {
                continue;
            }
            if member_workspace.generations[member] != member_generation {
                member_workspace.generations[member] = member_generation;
                member_workspace.touched.push(target.member);
            }
            member_workspace.distances[member] = total;
            member_workspace.terminals[member] = node;
            member_workspace.sources[member] = graph_source;
        }
    }
    member_workspace.touched.sort_unstable_by(|left, right| {
        member_workspace.distances[*left as usize]
            .cmp(&member_workspace.distances[*right as usize])
            .then_with(|| left.cmp(right))
    });
    let mut member_indices = Vec::with_capacity(member_workspace.touched.len());
    let mut distances_m = Vec::with_capacity(member_workspace.touched.len());
    let mut terminals = Vec::with_capacity(member_workspace.touched.len());
    let mut source_terminals = Vec::with_capacity(member_workspace.touched.len());
    for &member in &member_workspace.touched {
        member_indices.push(member);
        distances_m.push(
            member_workspace.distances[member as usize] as f64 / CCH_DISTANCE_UNITS_PER_METER,
        );
        terminals.push(member_workspace.terminals[member as usize]);
        source_terminals.push(member_workspace.sources[member as usize]);
    }
    Ok(FrontierSearch {
        member_indices,
        distances_m,
        terminals,
        source_terminals,
        source_snaps: source_snaps.to_vec(),
        terminal_attachment: None,
        predecessors: Vec::new(),
        reverse_direction,
        source_longitude,
        source_latitude,
        maximum_distance_m,
        cch_accelerated: true,
        settled_nodes: 0,
        relaxed_edges: 0,
    })
}

fn build_targets(
    snapshot: &Snapshot,
    workspace: &mut TileWorkspace,
    profile: &AccessProfile,
    members: &[u32],
    source_snaps: &[Snap],
) -> napi::Result<FrontierTargets> {
    let component_by_node = snapshot.i32_array("componentByNode")?;
    let mut source_components = source_snaps
        .iter()
        .map(|snap| component_by_node[snap.node as usize])
        .collect::<Vec<_>>();
    source_components.sort_unstable();
    source_components.dedup();
    workspace.begin_target_members(profile.member_lons.len());
    let mut minimum_snap_by_member = vec![f64::INFINITY; members.len()];
    let mut target_nodes = Vec::<u32>::new();
    for (member_offset, &member) in members.iter().enumerate() {
        for &anchor in profile.member_anchor_indices(member as usize) {
            for snap in &profile.anchor_snaps[anchor as usize] {
                if source_components
                    .binary_search(&component_by_node[snap.node as usize])
                    .is_ok()
                {
                    workspace.mark_target_node(snap.node);
                    target_nodes.push(snap.node);
                    minimum_snap_by_member[member_offset] =
                        minimum_snap_by_member[member_offset].min(snap.distance_m);
                }
            }
        }
        if minimum_snap_by_member[member_offset].is_finite() {
            workspace.activate_target_member(member, member_offset as u32);
        }
    }
    let unresolved_member_offsets = minimum_snap_by_member
        .iter()
        .enumerate()
        .filter_map(|(offset, distance)| distance.is_finite().then_some(offset as u32))
        .collect();
    target_nodes.sort_unstable();
    target_nodes.dedup();
    Ok(FrontierTargets {
        members: members.to_vec(),
        target_nodes,
        minimum_snap_by_member,
        unresolved_member_offsets,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_cch_frontier_search(
    snapshot: &Snapshot,
    workspace: &mut TileWorkspace,
    profile: &AccessProfile,
    structure: &cch::CchBundle,
    metric: &cch::MetricBundle,
    query: &mut DynamicCchQuery,
    source_snaps: &[Snap],
    members: &[u32],
    source_longitude: f64,
    source_latitude: f64,
    maximum_distance_m: f64,
    reverse_direction: bool,
) -> napi::Result<FrontierSearch> {
    if source_snaps.is_empty() || members.is_empty() {
        return Ok(FrontierSearch {
            member_indices: Vec::new(),
            distances_m: Vec::new(),
            terminals: Vec::new(),
            source_terminals: Vec::new(),
            source_snaps: source_snaps.to_vec(),
            terminal_attachment: None,
            predecessors: Vec::new(),
            reverse_direction,
            source_longitude,
            source_latitude,
            maximum_distance_m,
            cch_accelerated: true,
            settled_nodes: 0,
            relaxed_edges: 0,
        });
    }
    workspace.begin(
        snapshot,
        source_longitude,
        source_latitude,
        maximum_distance_m,
    )?;
    let targets = build_targets(snapshot, workspace, profile, members, source_snaps)?;
    if targets.target_nodes.is_empty() {
        return Ok(FrontierSearch {
            member_indices: Vec::new(),
            distances_m: Vec::new(),
            terminals: Vec::new(),
            source_terminals: Vec::new(),
            source_snaps: source_snaps.to_vec(),
            terminal_attachment: None,
            predecessors: Vec::new(),
            reverse_direction,
            source_longitude,
            source_latitude,
            maximum_distance_m,
            cch_accelerated: true,
            settled_nodes: 0,
            relaxed_edges: 0,
        });
    }
    let sources = source_snaps
        .iter()
        .map(|snap| {
            (
                snap.node,
                (snap.distance_m * CCH_DISTANCE_UNITS_PER_METER)
                    .round()
                    .clamp(0.0, (cch::INF_WEIGHT - 1) as f64) as u32,
            )
        })
        .collect::<Vec<_>>();
    let structure_view = structure.view();
    let metric_view = metric.view();
    let reverse_metric;
    let selected_metric = if reverse_direction {
        reverse_metric = cch::bundle::MetricView {
            forward: metric_view.backward,
            backward: metric_view.forward,
        };
        &reverse_metric
    } else {
        &metric_view
    };
    let node_distances = query.distances(
        &structure_view,
        selected_metric,
        &sources,
        &targets.target_nodes,
    );
    let mut best_distances = vec![f64::INFINITY; targets.members.len()];
    let mut best_terminals = vec![NO_PREDECESSOR; targets.members.len()];
    for (&node, &graph_distance) in targets.target_nodes.iter().zip(node_distances) {
        if graph_distance == cch::INF_WEIGHT {
            continue;
        }
        for target in profile.targets_for_node(node) {
            let Some(member_offset) = workspace.active_target_member_offset(target.member) else {
                continue;
            };
            let target_snap_units = (target.snap_distance_m * CCH_DISTANCE_UNITS_PER_METER)
                .round()
                .clamp(0.0, (cch::INF_WEIGHT - 1) as f64)
                as u32;
            let total_units = graph_distance
                .saturating_add(target_snap_units)
                .min(cch::INF_WEIGHT);
            let total_m = total_units as f64 / CCH_DISTANCE_UNITS_PER_METER;
            if total_m <= maximum_distance_m && total_m < best_distances[member_offset] {
                best_distances[member_offset] = total_m;
                best_terminals[member_offset] = node;
            }
        }
    }
    let mut ordered = targets
        .members
        .iter()
        .enumerate()
        .filter_map(|(member_offset, member)| {
            best_distances[member_offset].is_finite().then_some((
                *member,
                best_distances[member_offset],
                best_terminals[member_offset],
            ))
        })
        .collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        left.1
            .total_cmp(&right.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut member_indices = Vec::with_capacity(ordered.len());
    let mut distances_m = Vec::with_capacity(ordered.len());
    let mut terminals = Vec::with_capacity(ordered.len());
    for (member, distance, terminal) in ordered {
        member_indices.push(member);
        distances_m.push(distance);
        terminals.push(terminal);
    }
    Ok(FrontierSearch {
        member_indices,
        distances_m,
        terminals,
        source_terminals: Vec::new(),
        source_snaps: source_snaps.to_vec(),
        terminal_attachment: None,
        predecessors: Vec::new(),
        reverse_direction,
        source_longitude,
        source_latitude,
        maximum_distance_m,
        cch_accelerated: true,
        settled_nodes: 0,
        relaxed_edges: 0,
    })
}

#[inline(always)]
fn is_frontier_chain_node(
    workspace: &TileWorkspace,
    node: u32,
    edge_offsets: &[u32],
    edge_targets: &[u32],
    reverse_offsets: &[u32],
    reverse_sources: &[u32],
) -> bool {
    let Some(local_node) = workspace.local_offset(node) else {
        return false;
    };
    // Candidate snap vertices and endpoint seed vertices are query terminals;
    // settling them is required both for exact target accounting and for a
    // complete predecessor witness.
    if workspace.is_target_local(local_node) {
        return false;
    }
    let node = node as usize;
    let edge_start = edge_offsets[node] as usize;
    let edge_end = edge_offsets[node + 1] as usize;
    let reverse_start = reverse_offsets[node] as usize;
    let reverse_end = reverse_offsets[node + 1] as usize;
    if edge_end - edge_start != 2 || reverse_end - reverse_start != 2 {
        return false;
    }
    let first = edge_targets[edge_start];
    let second = edge_targets[edge_start + 1];
    if first == second {
        return false;
    }
    let reverse_first = reverse_sources[reverse_start];
    let reverse_second = reverse_sources[reverse_start + 1];
    (first == reverse_first && second == reverse_second)
        || (first == reverse_second && second == reverse_first)
}

#[allow(clippy::too_many_arguments)]
fn follow_forward_frontier_arc(
    workspace: &TileWorkspace,
    source: u32,
    first_node: u32,
    first_distance_m: f64,
    source_distance_m: f64,
    maximum_distance_m: f64,
    edge_offsets: &[u32],
    edge_targets: &[u32],
    edge_distances: &[f64],
    reverse_offsets: &[u32],
    reverse_sources: &[u32],
) -> Option<ContractedPointArc> {
    let mut previous = source;
    let mut current = first_node;
    let mut candidate_distance_m = source_distance_m + first_distance_m;
    let mut traversed_edges = 1_u32;
    let mut skipped_nodes = 0_u32;
    if candidate_distance_m > maximum_distance_m {
        return None;
    }
    while is_frontier_chain_node(
        workspace,
        current,
        edge_offsets,
        edge_targets,
        reverse_offsets,
        reverse_sources,
    ) {
        let current_index = current as usize;
        let start = edge_offsets[current_index] as usize;
        let edge = if edge_targets[start] != previous {
            start
        } else {
            start + 1
        };
        candidate_distance_m += edge_distances[edge];
        if candidate_distance_m > maximum_distance_m {
            return None;
        }
        previous = current;
        current = edge_targets[edge];
        traversed_edges = traversed_edges.saturating_add(1);
        skipped_nodes = skipped_nodes.saturating_add(1);
        if traversed_edges as usize > edge_targets.len() {
            return None;
        }
    }
    Some(ContractedPointArc {
        target: current,
        first_node,
        candidate_distance_m,
        traversed_edges,
        skipped_nodes,
    })
}

#[allow(clippy::too_many_arguments)]
fn follow_reverse_frontier_arc(
    workspace: &TileWorkspace,
    source: u32,
    first_node: u32,
    first_distance_m: f64,
    source_distance_m: f64,
    maximum_distance_m: f64,
    edge_offsets: &[u32],
    edge_targets: &[u32],
    edge_distances: &[f64],
    reverse_offsets: &[u32],
    reverse_sources: &[u32],
    reverse_edge_indices: &[u32],
) -> Option<ContractedPointArc> {
    let mut previous = source;
    let mut current = first_node;
    let mut candidate_distance_m = source_distance_m + first_distance_m;
    let mut traversed_edges = 1_u32;
    let mut skipped_nodes = 0_u32;
    if candidate_distance_m > maximum_distance_m {
        return None;
    }
    while is_frontier_chain_node(
        workspace,
        current,
        edge_offsets,
        edge_targets,
        reverse_offsets,
        reverse_sources,
    ) {
        let current_index = current as usize;
        let start = reverse_offsets[current_index] as usize;
        let reverse = if reverse_sources[start] != previous {
            start
        } else {
            start + 1
        };
        candidate_distance_m += edge_distances[reverse_edge_indices[reverse] as usize];
        if candidate_distance_m > maximum_distance_m {
            return None;
        }
        previous = current;
        current = reverse_sources[reverse];
        traversed_edges = traversed_edges.saturating_add(1);
        skipped_nodes = skipped_nodes.saturating_add(1);
        if traversed_edges as usize > edge_targets.len() {
            return None;
        }
    }
    Some(ContractedPointArc {
        target: current,
        // Reverse traversal discovers a forward arc from `current` back to
        // `source`; `previous` is its first raw node in itinerary order.
        first_node: previous,
        candidate_distance_m,
        traversed_edges,
        skipped_nodes,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_frontier_search(
    snapshot: &Snapshot,
    workspace: &mut TileWorkspace,
    profile: &AccessProfile,
    source_snaps: &[Snap],
    members: &[u32],
    source_longitude: f64,
    source_latitude: f64,
    maximum_distance_m: f64,
    reverse_direction: bool,
) -> napi::Result<FrontierSearch> {
    if source_snaps.is_empty() || members.is_empty() {
        return Ok(FrontierSearch {
            member_indices: Vec::new(),
            distances_m: Vec::new(),
            terminals: Vec::new(),
            source_terminals: Vec::new(),
            source_snaps: source_snaps.to_vec(),
            terminal_attachment: None,
            predecessors: Vec::new(),
            reverse_direction,
            source_longitude,
            source_latitude,
            maximum_distance_m,
            cch_accelerated: false,
            settled_nodes: 0,
            relaxed_edges: 0,
        });
    }
    let generation = workspace.begin(
        snapshot,
        source_longitude,
        source_latitude,
        maximum_distance_m,
    )?;
    let edge_offsets = snapshot.u32_array("edgeOffsets")?;
    let edge_targets = snapshot.u32_array("edgeTargets")?;
    let edge_distances = snapshot.f64_array("edgeDistances")?;
    let reverse_offsets = snapshot.u32_array("reverseOffsets")?;
    let reverse_sources = snapshot.u32_array("reverseSources")?;
    let reverse_edge_indices = snapshot.u32_array("reverseEdgeIndices")?;
    let mut targets = build_targets(snapshot, workspace, profile, members, source_snaps)?;
    if targets.unresolved_member_offsets.is_empty() {
        return Ok(FrontierSearch {
            member_indices: Vec::new(),
            distances_m: Vec::new(),
            terminals: Vec::new(),
            source_terminals: Vec::new(),
            source_snaps: source_snaps.to_vec(),
            terminal_attachment: None,
            predecessors: Vec::new(),
            reverse_direction,
            source_longitude,
            source_latitude,
            maximum_distance_m,
            cch_accelerated: false,
            settled_nodes: 0,
            relaxed_edges: 0,
        });
    }
    for snap in source_snaps {
        workspace.mark_target_node(snap.node);
    }
    for snap in source_snaps {
        let Some((node, _)) = workspace.local_location(snap.node) else {
            continue;
        };
        if workspace.generations[node] == generation && snap.distance_m >= workspace.distances[node]
        {
            continue;
        }
        workspace.generations[node] = generation;
        workspace.distances[node] = snap.distance_m;
        workspace.predecessors[node] = NO_PREDECESSOR;
        workspace.predecessor_first_nodes[node] = NO_PREDECESSOR;
        workspace.queue.push(PointHeapEntry {
            node: snap.node,
            distance_m: snap.distance_m,
            priority_m: snap.distance_m,
        });
    }
    let mut best_distances = vec![f64::INFINITY; targets.members.len()];
    let mut best_terminals = vec![NO_PREDECESSOR; targets.members.len()];
    let mut next_certificate_distance_m = f64::INFINITY;
    let mut settled_nodes = 0_u32;
    let mut relaxed_edges = 0_u32;
    while let Some(current) = workspace.queue.pop() {
        let Some((local_node, range_index)) = workspace.local_location(current.node) else {
            continue;
        };
        if workspace.generations[local_node] != generation
            || current.distance_m.to_bits() != workspace.distances[local_node].to_bits()
        {
            continue;
        }
        if current.distance_m > maximum_distance_m {
            break;
        }
        settled_nodes = settled_nodes.saturating_add(1);
        let mut target_changed = false;
        if workspace.is_target_local(local_node) {
            for target in profile.targets_for_node(current.node) {
                let Some(member_offset) = workspace.active_target_member_offset(target.member)
                else {
                    continue;
                };
                let total = current.distance_m + target.snap_distance_m;
                if total > maximum_distance_m {
                    continue;
                }
                if total < best_distances[member_offset] {
                    best_distances[member_offset] = total;
                    best_terminals[member_offset] = current.node;
                    target_changed = true;
                }
            }
        }
        if target_changed || current.distance_m >= next_certificate_distance_m {
            targets.unresolved_member_offsets.retain(|member_offset| {
                let member_offset = *member_offset as usize;
                let distance = best_distances[member_offset];
                if !distance.is_finite() {
                    return true;
                }
                distance > current.distance_m + targets.minimum_snap_by_member[member_offset]
            });
            if targets.unresolved_member_offsets.is_empty() {
                break;
            }
            next_certificate_distance_m = targets
                .unresolved_member_offsets
                .iter()
                .filter_map(|member_offset| {
                    let member_offset = *member_offset as usize;
                    let distance = best_distances[member_offset];
                    distance
                        .is_finite()
                        .then_some(distance - targets.minimum_snap_by_member[member_offset])
                })
                .fold(f64::INFINITY, f64::min);
        }
        if reverse_direction {
            let node = current.node as usize;
            let start = reverse_offsets[node] as usize;
            let end = reverse_offsets[node + 1] as usize;
            for reverse_edge in start..end {
                let Some(arc) = follow_reverse_frontier_arc(
                    workspace,
                    current.node,
                    reverse_sources[reverse_edge],
                    edge_distances[reverse_edge_indices[reverse_edge] as usize],
                    current.distance_m,
                    maximum_distance_m,
                    edge_offsets,
                    edge_targets,
                    edge_distances,
                    reverse_offsets,
                    reverse_sources,
                    reverse_edge_indices,
                ) else {
                    continue;
                };
                relaxed_edges = relaxed_edges.saturating_add(arc.traversed_edges);
                let next_node = arc.target;
                let Some((next, _)) = workspace.local_location_near(next_node, range_index) else {
                    continue;
                };
                let candidate = arc.candidate_distance_m;
                if workspace.generations[next] == generation
                    && candidate >= workspace.distances[next]
                {
                    continue;
                }
                workspace.generations[next] = generation;
                workspace.distances[next] = candidate;
                workspace.predecessors[next] = current.node;
                workspace.predecessor_first_nodes[next] = arc.first_node;
                workspace.queue.push(PointHeapEntry {
                    node: next_node,
                    distance_m: candidate,
                    priority_m: candidate,
                });
            }
        } else {
            let node = current.node as usize;
            for edge in edge_offsets[node] as usize..edge_offsets[node + 1] as usize {
                let Some(arc) = follow_forward_frontier_arc(
                    workspace,
                    current.node,
                    edge_targets[edge],
                    edge_distances[edge],
                    current.distance_m,
                    maximum_distance_m,
                    edge_offsets,
                    edge_targets,
                    edge_distances,
                    reverse_offsets,
                    reverse_sources,
                ) else {
                    continue;
                };
                relaxed_edges = relaxed_edges.saturating_add(arc.traversed_edges);
                let next_node = arc.target;
                let Some((next, _)) = workspace.local_location_near(next_node, range_index) else {
                    continue;
                };
                let candidate = arc.candidate_distance_m;
                if workspace.generations[next] == generation
                    && candidate >= workspace.distances[next]
                {
                    continue;
                }
                workspace.generations[next] = generation;
                workspace.distances[next] = candidate;
                workspace.predecessors[next] = current.node;
                workspace.predecessor_first_nodes[next] = arc.first_node;
                workspace.queue.push(PointHeapEntry {
                    node: next_node,
                    distance_m: candidate,
                    priority_m: candidate,
                });
            }
        }
    }
    let mut ordered = targets
        .members
        .iter()
        .enumerate()
        .filter_map(|(member_offset, member)| {
            best_distances[member_offset].is_finite().then_some((
                *member,
                best_distances[member_offset],
                best_terminals[member_offset],
            ))
        })
        .collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        left.1
            .total_cmp(&right.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut predecessor_nodes = Vec::<u32>::new();
    let mut member_indices = Vec::with_capacity(ordered.len());
    let mut distances_m = Vec::with_capacity(ordered.len());
    let mut terminals = Vec::with_capacity(ordered.len());
    for (member, distance, terminal) in ordered {
        let mut cursor = terminal;
        while cursor != NO_PREDECESSOR {
            let Some(cursor_offset) = workspace.local_offset(cursor) else {
                break;
            };
            if workspace.generations[cursor_offset] != generation {
                break;
            }
            predecessor_nodes.push(cursor);
            let predecessor = workspace.predecessors[cursor_offset];
            // A zero generation is never a live search generation. Reusing the
            // search marker here deduplicates shared suffixes without a second
            // node-sized marker array.
            workspace.generations[cursor_offset] = 0;
            cursor = predecessor;
        }
        member_indices.push(member);
        distances_m.push(distance);
        terminals.push(terminal);
    }
    predecessor_nodes.sort_unstable();
    let predecessors = predecessor_nodes
        .into_iter()
        .filter_map(|node| {
            workspace.local_offset(node).map(|offset| {
                (
                    node,
                    workspace.predecessors[offset],
                    workspace.predecessor_first_nodes[offset],
                )
            })
        })
        .collect();
    Ok(FrontierSearch {
        member_indices,
        distances_m,
        terminals,
        source_terminals: Vec::new(),
        source_snaps: source_snaps.to_vec(),
        terminal_attachment: None,
        predecessors,
        reverse_direction,
        source_longitude,
        source_latitude,
        maximum_distance_m,
        cch_accelerated: false,
        settled_nodes,
        relaxed_edges,
    })
}

fn predecessor_path(workspace: &TileWorkspace, generation: u32, terminal: u32) -> Vec<u32> {
    let mut path = Vec::new();
    let mut cursor = terminal;
    while cursor != NO_PREDECESSOR && path.len() < 100_000 {
        let Some(offset) = workspace.local_offset(cursor) else {
            break;
        };
        if workspace.generations[offset] != generation {
            break;
        }
        path.push(cursor);
        cursor = workspace.predecessors[offset];
    }
    path
}

fn append_contracted_point_segment(
    path: &mut Vec<u32>,
    source: u32,
    target: u32,
    first_node: u32,
    edge_offsets: &[u32],
    edge_targets: &[u32],
) -> napi::Result<()> {
    if source == target {
        return Ok(());
    }
    if first_node == NO_PREDECESSOR {
        return Err(Error::from_reason(
            "Contracted street predecessor is missing its first raw node.",
        ));
    }
    let mut previous = source;
    let mut current = first_node;
    let mut steps = 0_usize;
    while current != target {
        path.push(current);
        if path.len() >= 100_000 {
            return Err(Error::from_reason(
                "Contracted street path exceeds the materialization bound.",
            ));
        }
        let current_index = current as usize;
        let start = edge_offsets[current_index] as usize;
        let end = edge_offsets[current_index + 1] as usize;
        if end - start != 2 || edge_targets[start] == edge_targets[start + 1] {
            return Err(Error::from_reason(
                "Contracted street path encountered a non-chain interior node.",
            ));
        }
        let next = if edge_targets[start] != previous {
            edge_targets[start]
        } else {
            edge_targets[start + 1]
        };
        previous = current;
        current = next;
        steps += 1;
        if steps > edge_targets.len() {
            return Err(Error::from_reason(
                "Contracted street path contains a topology cycle without a query terminal.",
            ));
        }
    }
    path.push(target);
    Ok(())
}

fn materialize_forward_contracted_point_path(
    workspace: &TileWorkspace,
    generation: u32,
    terminal: u32,
    edge_offsets: &[u32],
    edge_targets: &[u32],
) -> napi::Result<Vec<u32>> {
    let mut vertices = predecessor_path(workspace, generation, terminal);
    vertices.reverse();
    let Some(first) = vertices.first().copied() else {
        return Ok(Vec::new());
    };
    let mut path = vec![first];
    for target in vertices.into_iter().skip(1) {
        let offset = workspace.local_offset(target).ok_or_else(|| {
            Error::from_reason("Contracted A* predecessor is outside its query workspace.")
        })?;
        append_contracted_point_segment(
            &mut path,
            workspace.predecessors[offset],
            target,
            workspace.predecessor_first_nodes[offset],
            edge_offsets,
            edge_targets,
        )?;
    }
    Ok(path)
}

struct PointPath {
    distance_m: f64,
    origin_snap_distance_m: f64,
    destination_snap_distance_m: f64,
    nodes: Vec<u32>,
    settled_nodes: u32,
    relaxed_edges: u32,
    chain_skipped_nodes: u32,
    contracted_arc_relaxations: u32,
    cch_accelerated: bool,
}

struct PointPathMetricCertificate {
    target_longitude_radians: f64,
    target_latitude_radians: f64,
    longitude_scale: f64,
    scaled_radius_squared_m: f64,
}

impl PointPathMetricCertificate {
    fn new(target: [f64; 2], latitude_limit_radians: f64) -> Self {
        Self {
            target_longitude_radians: target[0].to_radians(),
            target_latitude_radians: target[1].to_radians(),
            longitude_scale: latitude_limit_radians.cos().max(0.0),
            scaled_radius_squared_m: (EARTH_RADIUS_M * POINT_PATH_METRIC_LOWER_BOUND_FACTOR)
                .powi(2),
        }
    }

    #[inline(always)]
    fn lower_bound_m(&self, node_longitude: f64, node_latitude: f64) -> f64 {
        let latitude_delta = node_latitude.to_radians() - self.target_latitude_radians;
        let longitude_delta = (node_longitude.to_radians() - self.target_longitude_radians).abs();
        let wrapped_longitude_delta = if longitude_delta > std::f64::consts::PI {
            std::f64::consts::TAU - longitude_delta
        } else {
            longitude_delta
        };
        let scaled_longitude_delta = self.longitude_scale * wrapped_longitude_delta;
        let normalized_lower_bound_squared =
            latitude_delta * latitude_delta + scaled_longitude_delta * scaled_longitude_delta;
        (self.scaled_radius_squared_m * normalized_lower_bound_squared).sqrt()
    }
}

struct PointMeeting {
    distance_m: f64,
    origin_snap_distance_m: f64,
    destination_snap_distance_m: f64,
    total_snap_distance_m: f64,
    node: u32,
}

#[derive(Clone, Copy)]
struct ContractedPointArc {
    target: u32,
    first_node: u32,
    candidate_distance_m: f64,
    traversed_edges: u32,
    skipped_nodes: u32,
}

#[inline(always)]
fn is_point_terminal(terminals: &[u32], node: u32) -> bool {
    terminals.binary_search(&node).is_ok()
}

#[inline(always)]
fn is_reciprocal_degree_two_node(
    node: u32,
    terminals: &[u32],
    edge_offsets: &[u32],
    edge_targets: &[u32],
    reverse_offsets: &[u32],
    reverse_sources: &[u32],
) -> bool {
    if is_point_terminal(terminals, node) {
        return false;
    }
    let node = node as usize;
    let edge_start = edge_offsets[node] as usize;
    let edge_end = edge_offsets[node + 1] as usize;
    let reverse_start = reverse_offsets[node] as usize;
    let reverse_end = reverse_offsets[node + 1] as usize;
    if edge_end - edge_start != 2 || reverse_end - reverse_start != 2 {
        return false;
    }
    let first = edge_targets[edge_start];
    let second = edge_targets[edge_start + 1];
    if first == second {
        return false;
    }
    let reverse_first = reverse_sources[reverse_start];
    let reverse_second = reverse_sources[reverse_start + 1];
    (first == reverse_first && second == reverse_second)
        || (first == reverse_second && second == reverse_first)
}

#[allow(clippy::too_many_arguments)]
fn follow_forward_point_arc(
    source: u32,
    first_node: u32,
    first_distance_m: f64,
    source_distance_m: f64,
    maximum_distance_m: f64,
    contract_chains: bool,
    terminals: &[u32],
    edge_offsets: &[u32],
    edge_targets: &[u32],
    edge_distances: &[f64],
    reverse_offsets: &[u32],
    reverse_sources: &[u32],
) -> Option<ContractedPointArc> {
    let mut previous = source;
    let mut current = first_node;
    let mut candidate_distance_m = source_distance_m + first_distance_m;
    let mut traversed_edges = 1_u32;
    let mut skipped_nodes = 0_u32;
    if candidate_distance_m > maximum_distance_m {
        return None;
    }
    while contract_chains
        && is_reciprocal_degree_two_node(
            current,
            terminals,
            edge_offsets,
            edge_targets,
            reverse_offsets,
            reverse_sources,
        )
    {
        let current_index = current as usize;
        let start = edge_offsets[current_index] as usize;
        let edge = if edge_targets[start] != previous {
            start
        } else {
            start + 1
        };
        let next = edge_targets[edge];
        candidate_distance_m += edge_distances[edge];
        if candidate_distance_m > maximum_distance_m {
            return None;
        }
        previous = current;
        current = next;
        traversed_edges = traversed_edges.saturating_add(1);
        skipped_nodes = skipped_nodes.saturating_add(1);
        if traversed_edges as usize > edge_targets.len() {
            return None;
        }
    }
    Some(ContractedPointArc {
        target: current,
        first_node,
        candidate_distance_m,
        traversed_edges,
        skipped_nodes,
    })
}

#[derive(Clone, Copy)]
struct PointPathOptions {
    maximum_distance_m: f64,
    contract_chains: bool,
}

fn directed_node_path_distance_m(snapshot: &Snapshot, nodes: &[u32]) -> napi::Result<f64> {
    let edge_offsets = snapshot.u32_array("edgeOffsets")?;
    let edge_targets = snapshot.u32_array("edgeTargets")?;
    let edge_distances = snapshot.f64_array("edgeDistances")?;
    let mut distance_m = 0.0;
    for edge_nodes in nodes.windows(2) {
        let source = edge_nodes[0] as usize;
        let target = edge_nodes[1];
        let start = edge_offsets[source] as usize;
        let end = edge_offsets[source + 1] as usize;
        let edge_distance_m = (start..end)
            .filter(|&edge| edge_targets[edge] == target)
            .map(|edge| edge_distances[edge])
            .min_by(f64::total_cmp)
            .ok_or_else(|| {
                Error::from_reason(
                    "Street CCH path unpacking produced a node pair without a directed raw edge.",
                )
            })?;
        distance_m += edge_distance_m;
    }
    Ok(distance_m)
}

struct CchCoordinateTargets {
    coordinates: Vec<(f64, f64)>,
    nodes: Vec<u32>,
    snap_units: Vec<u32>,
    offsets: Vec<usize>,
    snapped_targets: u32,
}

#[inline(always)]
fn cch_distance_units(distance_m: f64) -> u32 {
    (distance_m * CCH_DISTANCE_UNITS_PER_METER)
        .round()
        .clamp(0.0, (cch::INF_WEIGHT - 1) as f64) as u32
}

fn prepare_cch_coordinate_targets(
    snapshot: &Snapshot,
    reciprocal_edge_flags: &[u8],
    coordinates: &[f64],
) -> napi::Result<CchCoordinateTargets> {
    if !coordinates.len().is_multiple_of(2) {
        return Err(Error::from_reason(
            "Street CCH targets require longitude/latitude pairs.",
        ));
    }
    let target_count = coordinates.len() / 2;
    let mut normalized_coordinates = Vec::with_capacity(target_count);
    let mut nodes = Vec::new();
    let mut snap_units = Vec::new();
    let mut offsets = Vec::with_capacity(target_count + 1);
    let mut snapped_targets = 0_u32;
    offsets.push(0);
    for target in 0..target_count {
        let longitude = coordinates[target * 2];
        let latitude = coordinates[target * 2 + 1];
        let snaps = snaps_for_coordinate(snapshot, reciprocal_edge_flags, longitude, latitude)?;
        if !snaps.is_empty() {
            snapped_targets = snapped_targets.saturating_add(1);
        }
        for snap in &snaps {
            nodes.push(snap.node);
            snap_units.push(cch_distance_units(snap.distance_m));
        }
        offsets.push(nodes.len());
        normalized_coordinates.push((longitude, latitude));
    }
    Ok(CchCoordinateTargets {
        coordinates: normalized_coordinates,
        nodes,
        snap_units,
        offsets,
        snapped_targets,
    })
}

fn cch_coordinate_targets_from_snap_sets(
    coordinates: &[f64],
    snap_sets: &[Vec<Snap>],
) -> CchCoordinateTargets {
    let target_count = coordinates.len() / 2;
    let mut nodes = Vec::new();
    let mut snap_units = Vec::new();
    let mut offsets = Vec::with_capacity(target_count + 1);
    offsets.push(0);
    let mut snapped_targets = 0_u32;
    for snaps in snap_sets {
        if !snaps.is_empty() {
            snapped_targets = snapped_targets.saturating_add(1);
        }
        for snap in snaps {
            nodes.push(snap.node);
            snap_units.push(cch_distance_units(snap.distance_m));
        }
        offsets.push(nodes.len());
    }
    CchCoordinateTargets {
        coordinates: coordinates
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| (pair[0], pair[1]))
            .collect(),
        nodes,
        snap_units,
        offsets,
        snapped_targets,
    }
}

fn cch_distances_to_coordinate_targets(
    index: &mut StreetCchIndex,
    sources: &[(u32, u32)],
    targets: &CchCoordinateTargets,
    maximum_distance_m: f64,
    buckets: Option<&CchTargetBuckets>,
    reverse: bool,
) -> Vec<f64> {
    let maximum_distance_units = cch_distance_units(maximum_distance_m);
    let StreetCchIndex {
        structure,
        metric,
        forward_query,
        reverse_query,
        ..
    } = index;
    let metric = metric.view();
    let metric = if reverse {
        cch::bundle::MetricView {
            forward: metric.backward,
            backward: metric.forward,
        }
    } else {
        metric
    };
    let query = if reverse {
        reverse_query
    } else {
        forward_query
    };
    let mut bucket_distances;
    let raw = if let Some(buckets) = buckets {
        let (indices, distances, _) = query.range_targets(
            &structure.view(),
            metric.forward,
            buckets,
            sources,
            maximum_distance_units,
            targets.nodes.len(),
        );
        bucket_distances = vec![cch::INF_WEIGHT; targets.nodes.len()];
        for (&target, &distance) in indices.iter().zip(distances) {
            bucket_distances[target as usize] = distance;
        }
        &bucket_distances
    } else {
        query.distances(&structure.view(), &metric, sources, &targets.nodes)
    };
    let mut distances_m = vec![f64::INFINITY; targets.coordinates.len()];
    for (target, distance_m) in distances_m.iter_mut().enumerate() {
        let mut best = cch::INF_WEIGHT;
        let start = targets.offsets[target];
        let end = targets.offsets[target + 1];
        for (&graph_distance, &snap_units) in
            raw[start..end].iter().zip(&targets.snap_units[start..end])
        {
            if graph_distance == cch::INF_WEIGHT {
                continue;
            }
            best = best.min(
                graph_distance
                    .saturating_add(snap_units)
                    .min(cch::INF_WEIGHT),
            );
        }
        if best <= maximum_distance_units {
            *distance_m = best as f64 / CCH_DISTANCE_UNITS_PER_METER;
        }
    }
    distances_m
}

#[allow(clippy::too_many_arguments)]
fn run_cch_coordinate_distances(
    snapshot: &Snapshot,
    reciprocal_edge_flags: &[u8],
    index: &mut StreetCchIndex,
    targets: &CchCoordinateTargets,
    source_longitude: f64,
    source_latitude: f64,
    maximum_distance_m: f64,
) -> napi::Result<(Vec<f64>, u32, f64)> {
    let started = Instant::now();
    let source_snaps = snaps_for_coordinate(
        snapshot,
        reciprocal_edge_flags,
        source_longitude,
        source_latitude,
    )?;
    let maximum_distance_units = cch_distance_units(maximum_distance_m);
    let sources = source_snaps
        .iter()
        .map(|snap| (snap.node, cch_distance_units(snap.distance_m)))
        .filter(|(_, distance)| *distance <= maximum_distance_units)
        .collect::<Vec<_>>();
    let mut distances_m = cch_distances_to_coordinate_targets(
        index,
        &sources,
        targets,
        maximum_distance_m,
        None,
        false,
    );
    for (target, &(longitude, latitude)) in targets.coordinates.iter().enumerate() {
        if source_longitude == longitude && source_latitude == latitude {
            distances_m[target] = 0.0;
        }
    }
    Ok((
        distances_m,
        sources.len() as u32,
        started.elapsed().as_nanos() as f64,
    ))
}

fn coordinate_matrix_buckets(
    index: &StreetCchIndex,
    targets: &CchCoordinateTargets,
    origin_count: usize,
    maximum_distance_m: f64,
    reverse: bool,
) -> napi::Result<Option<CchTargetBuckets>> {
    // Amortize target-side distances across matrix rows. Small queries use the
    // resident elimination-tree workspace and avoid graph-sized bucket setup.
    if origin_count < 32 || targets.nodes.len() < 8 {
        return Ok(None);
    }
    build_cch_target_buckets(
        &index.structure.view(),
        if reverse {
            index.metric.view().forward
        } else {
            index.metric.view().backward
        },
        &targets.nodes,
        cch_distance_units(maximum_distance_m),
    )
    .map(Some)
}

fn run_cch_coordinate_distance_matrix(
    index: &mut StreetCchIndex,
    targets: &CchCoordinateTargets,
    maximum_distance_m: f64,
) -> napi::Result<(Vec<f64>, u32, f64)> {
    let started = Instant::now();
    let target_count = targets.coordinates.len();
    let buckets =
        coordinate_matrix_buckets(index, targets, target_count, maximum_distance_m, false)?;
    let mut distances_m = vec![f64::INFINITY; target_count * target_count];
    let mut ready_pairs = 0_u32;
    for source in 0..target_count {
        let sources = (targets.offsets[source]..targets.offsets[source + 1])
            .map(|snap_index| (targets.nodes[snap_index], targets.snap_units[snap_index]))
            .collect::<Vec<_>>();
        let row = cch_distances_to_coordinate_targets(
            index,
            &sources,
            targets,
            maximum_distance_m,
            buckets.as_ref(),
            false,
        );
        for (target, &row_distance) in row.iter().enumerate() {
            let matrix_index = source * target_count + target;
            if targets.coordinates[source] == targets.coordinates[target] {
                distances_m[matrix_index] = 0.0;
                ready_pairs = ready_pairs.saturating_add(1);
                continue;
            }
            if row_distance.is_finite() {
                distances_m[matrix_index] = row_distance;
                ready_pairs = ready_pairs.saturating_add(1);
            }
        }
    }
    Ok((
        distances_m,
        ready_pairs,
        started.elapsed().as_nanos() as f64,
    ))
}

fn run_cch_point_path(
    snapshot: &Snapshot,
    index: &mut StreetCchIndex,
    origins: &[Snap],
    destinations: &[Snap],
    maximum_distance_m: f64,
) -> napi::Result<Option<PointPath>> {
    if origins.is_empty() || destinations.is_empty() {
        return Ok(None);
    }
    index.prepare_path_query();
    let metric = index.metric.view();
    let query = index
        .path_query
        .as_mut()
        .expect("street CCH path query was prepared");
    let mut best: Option<PointPath> = None;
    for origin in origins {
        for destination in destinations {
            let Some(nodes) = query.path(&metric, origin.node, destination.node) else {
                continue;
            };
            let graph_distance_m = directed_node_path_distance_m(snapshot, &nodes)?;
            let distance_m = origin.distance_m + graph_distance_m + destination.distance_m;
            if distance_m > maximum_distance_m {
                continue;
            }
            let total_snap_distance_m = origin.distance_m + destination.distance_m;
            let replace = best.as_ref().is_none_or(|current| {
                let current_total_snap_distance_m =
                    current.origin_snap_distance_m + current.destination_snap_distance_m;
                distance_m < current.distance_m
                    || (distance_m == current.distance_m
                        && (total_snap_distance_m < current_total_snap_distance_m
                            || (total_snap_distance_m == current_total_snap_distance_m
                                && destination.distance_m < current.destination_snap_distance_m)))
            });
            if replace {
                best = Some(PointPath {
                    distance_m,
                    origin_snap_distance_m: origin.distance_m,
                    destination_snap_distance_m: destination.distance_m,
                    nodes,
                    // CCH touches elimination-tree ancestors and shortcut arcs,
                    // not raw graph labels. Keep non-comparable counters at
                    // zero rather than misreporting incomparable work units.
                    settled_nodes: 0,
                    relaxed_edges: 0,
                    chain_skipped_nodes: 0,
                    contracted_arc_relaxations: 0,
                    cch_accelerated: true,
                });
            }
        }
    }
    Ok(best)
}

fn run_point_path(
    snapshot: &Snapshot,
    forward: &mut TileWorkspace,
    backward: &mut TileWorkspace,
    origins: &[Snap],
    destinations: &[Snap],
    coordinates: [[f64; 2]; 2],
    options: PointPathOptions,
) -> napi::Result<Option<PointPath>> {
    let PointPathOptions {
        maximum_distance_m,
        contract_chains,
    } = options;
    if origins.is_empty() || destinations.is_empty() {
        return Ok(None);
    }
    let edge_offsets = snapshot.u32_array("edgeOffsets")?;
    let edge_targets = snapshot.u32_array("edgeTargets")?;
    let edge_distances = snapshot.f64_array("edgeDistances")?;
    let reverse_offsets = snapshot.u32_array("reverseOffsets")?;
    let reverse_sources = snapshot.u32_array("reverseSources")?;
    let node_lons = snapshot.f64_array("nodeLons")?;
    let node_lats = snapshot.f64_array("nodeLats")?;
    let component_by_node = snapshot.i32_array("componentByNode")?;
    let mut terminals = origins
        .iter()
        .chain(destinations.iter())
        .map(|snap| snap.node)
        .collect::<Vec<_>>();
    terminals.sort_unstable();
    terminals.dedup();
    if !origins.iter().any(|origin| {
        destinations.iter().any(|destination| {
            component_by_node[origin.node as usize] == component_by_node[destination.node as usize]
        })
    }) {
        return Ok(None);
    }
    let latitude_limit_radians = (coordinates
        .iter()
        .map(|coordinate| coordinate[1].to_radians().abs())
        .fold(0.0, f64::max)
        + maximum_distance_m / EARTH_RADIUS_M)
        .min(std::f64::consts::FRAC_PI_2);
    let certificate = PointPathMetricCertificate::new(coordinates[1], latitude_limit_radians);
    let generation = forward.begin(
        snapshot,
        coordinates[0][0],
        coordinates[0][1],
        maximum_distance_m,
    )?;
    let destination_generation = backward.begin(
        snapshot,
        coordinates[1][0],
        coordinates[1][1],
        maximum_distance_m,
    )?;
    for destination in destinations {
        let Some((node, _)) = backward.local_location(destination.node) else {
            continue;
        };
        if backward.generations[node] == destination_generation
            && destination.distance_m >= backward.distances[node]
        {
            continue;
        }
        backward.generations[node] = destination_generation;
        backward.distances[node] = destination.distance_m;
    }
    for origin in origins {
        let Some((node, _)) = forward.local_location(origin.node) else {
            continue;
        };
        if forward.generations[node] == generation {
            let existing_distance = forward.distances[node];
            let existing_origin_snap = forward.origin_snap_distances[node];
            if origin.distance_m > existing_distance
                || (origin.distance_m == existing_distance
                    && origin.distance_m >= existing_origin_snap)
            {
                continue;
            }
        }
        forward.generations[node] = generation;
        forward.distances[node] = origin.distance_m;
        forward.origin_snap_distances[node] = origin.distance_m;
        forward.predecessors[node] = NO_PREDECESSOR;
        forward.predecessor_first_nodes[node] = NO_PREDECESSOR;
        forward.point_queue.push(PointHeapEntry {
            node: origin.node,
            distance_m: origin.distance_m,
            priority_m: origin.distance_m
                + certificate.lower_bound_m(
                    node_lons[origin.node as usize],
                    node_lats[origin.node as usize],
                ),
        });
    }
    let mut best = PointMeeting {
        distance_m: f64::INFINITY,
        origin_snap_distance_m: 0.0,
        destination_snap_distance_m: 0.0,
        total_snap_distance_m: f64::INFINITY,
        node: NO_PREDECESSOR,
    };
    let mut settled_nodes = 0_u32;
    let mut relaxed_edges = 0_u32;
    let mut chain_skipped_nodes = 0_u32;
    let mut contracted_arc_relaxations = 0_u32;
    while let Some(current) = forward.point_queue.pop() {
        if current.priority_m > best.distance_m.min(maximum_distance_m) {
            break;
        }
        let Some((local_node, range_index)) = forward.local_location(current.node) else {
            continue;
        };
        if forward.generations[local_node] != generation
            || current.distance_m.to_bits() != forward.distances[local_node].to_bits()
        {
            continue;
        }
        settled_nodes = settled_nodes.saturating_add(1);
        if let Some(destination_offset) = backward.local_offset(current.node)
            && backward.generations[destination_offset] == destination_generation
        {
            let destination_snap = backward.distances[destination_offset];
            let distance_m = current.distance_m + destination_snap;
            let origin_snap = forward.origin_snap_distances[local_node];
            let total_snap = origin_snap + destination_snap;
            if distance_m <= maximum_distance_m
                && (distance_m < best.distance_m
                    || (distance_m == best.distance_m
                        && (total_snap < best.total_snap_distance_m
                            || (total_snap == best.total_snap_distance_m
                                && destination_snap < best.destination_snap_distance_m))))
            {
                best.distance_m = distance_m;
                best.origin_snap_distance_m = origin_snap;
                best.destination_snap_distance_m = destination_snap;
                best.total_snap_distance_m = total_snap;
                best.node = current.node;
            }
        }
        let node = current.node as usize;
        for edge in edge_offsets[node] as usize..edge_offsets[node + 1] as usize {
            let Some(arc) = follow_forward_point_arc(
                current.node,
                edge_targets[edge],
                edge_distances[edge],
                current.distance_m,
                maximum_distance_m,
                contract_chains,
                &terminals,
                edge_offsets,
                edge_targets,
                edge_distances,
                reverse_offsets,
                reverse_sources,
            ) else {
                continue;
            };
            relaxed_edges = relaxed_edges.saturating_add(arc.traversed_edges);
            chain_skipped_nodes = chain_skipped_nodes.saturating_add(arc.skipped_nodes);
            if contract_chains {
                contracted_arc_relaxations = contracted_arc_relaxations.saturating_add(1);
            }
            let next_node = arc.target;
            let Some((next, _)) = forward.local_location_near(next_node, range_index) else {
                continue;
            };
            let candidate = arc.candidate_distance_m;
            let origin_snap = forward.origin_snap_distances[local_node];
            if forward.generations[next] == generation
                && (candidate > forward.distances[next]
                    || (candidate == forward.distances[next]
                        && origin_snap >= forward.origin_snap_distances[next]))
            {
                continue;
            }
            let priority = candidate
                + certificate
                    .lower_bound_m(node_lons[next_node as usize], node_lats[next_node as usize]);
            if priority > best.distance_m.min(maximum_distance_m) {
                continue;
            }
            forward.generations[next] = generation;
            forward.distances[next] = candidate;
            forward.origin_snap_distances[next] = origin_snap;
            forward.predecessors[next] = current.node;
            forward.predecessor_first_nodes[next] = arc.first_node;
            forward.point_queue.push(PointHeapEntry {
                node: next_node,
                distance_m: candidate,
                priority_m: priority,
            });
        }
    }
    if best.node == NO_PREDECESSOR {
        return Ok(None);
    }
    let nodes = materialize_forward_contracted_point_path(
        forward,
        generation,
        best.node,
        edge_offsets,
        edge_targets,
    )?;
    Ok(Some(PointPath {
        distance_m: best.distance_m,
        origin_snap_distance_m: best.origin_snap_distance_m,
        destination_snap_distance_m: best.destination_snap_distance_m,
        nodes,
        settled_nodes,
        relaxed_edges,
        chain_skipped_nodes,
        contracted_arc_relaxations,
        cch_accelerated: false,
    }))
}

#[allow(clippy::too_many_arguments)]
fn terminal_endpoint_snaps(
    snapshot: &Snapshot,
    graph: Option<&TerminalAccessGraph>,
    snaps: Vec<Snap>,
    longitude: f64,
    latitude: f64,
    maximum: f64,
    reverse: bool,
) -> napi::Result<(Vec<Snap>, Option<Arc<TerminalAttachment>>)> {
    let attachment = match graph {
        Some(graph) => graph.attach(snapshot, &snaps, longitude, latitude, maximum, reverse)?,
        None => None,
    };
    let snaps = attachment
        .as_ref()
        .map_or(snaps, |a| a.boundary_snaps.clone());
    Ok((snaps, attachment))
}

fn flatten_access_path(
    snapshot: &Snapshot,
    graph: Option<&TerminalAccessGraph>,
    nodes: &[u32],
    maximum: usize,
) -> napi::Result<Vec<f64>> {
    match graph {
        Some(graph) => graph.flatten(snapshot, nodes, maximum),
        None => flatten_path(snapshot, nodes, maximum),
    }
}

fn finish_terminal_point_path(
    path: Option<PointPath>,
    origin: Option<&TerminalAttachment>,
    destination: Option<&TerminalAttachment>,
    maximum: f64,
) -> Option<PointPath> {
    if let Some((distance, target)) = origin.and_then(|a| destination.and_then(|b| a.direct_to(b)))
        && distance <= maximum
        && path.as_ref().is_none_or(|p| distance < p.distance_m)
    {
        let origin = origin.expect("private direct origin");
        let destination = destination.expect("private direct destination");
        let nodes = origin.path_to(target);
        return Some(PointPath {
            distance_m: distance,
            origin_snap_distance_m: origin
                .original_snaps
                .iter()
                .find(|s| Some(&s.node) == nodes.first())
                .map_or(0.0, |s| s.distance_m),
            destination_snap_distance_m: destination
                .original_snaps
                .iter()
                .find(|s| s.node == target)
                .map_or(0.0, |s| s.distance_m),
            nodes,
            settled_nodes: 0,
            relaxed_edges: 0,
            chain_skipped_nodes: 0,
            contracted_arc_relaxations: 0,
            cch_accelerated: false,
        });
    }
    path.map(|mut path| {
        if let Some(origin) = origin {
            path.nodes = origin.extend_path(path.nodes, false);
            path.origin_snap_distance_m = origin
                .original_snaps
                .iter()
                .find(|snap| Some(&snap.node) == path.nodes.first())
                .map_or(0.0, |snap| snap.distance_m);
        }
        if let Some(destination) = destination {
            path.nodes = destination.extend_path(path.nodes, true);
            path.destination_snap_distance_m = destination
                .original_snaps
                .iter()
                .find(|snap| Some(&snap.node) == path.nodes.last())
                .map_or(0.0, |snap| snap.distance_m);
        }
        path
    })
}

fn street_path_result(
    snapshot: &Snapshot,
    terminal_access: Option<&TerminalAccessGraph>,
    path: Option<PointPath>,
    maximum_points: u32,
    started: Instant,
) -> napi::Result<StreetPathResult> {
    Ok(match path {
        Some(path) => StreetPathResult {
            found: true,
            distance_m: path.distance_m,
            origin_snap_distance_m: path.origin_snap_distance_m,
            destination_snap_distance_m: path.destination_snap_distance_m,
            coordinates: flatten_access_path(
                snapshot,
                terminal_access,
                &path.nodes,
                maximum_points.max(2) as usize,
            )?,
            query_ns: started.elapsed().as_nanos() as f64,
            settled_nodes: path.settled_nodes,
            relaxed_edges: path.relaxed_edges,
            chain_skipped_nodes: path.chain_skipped_nodes,
            contracted_arc_relaxations: path.contracted_arc_relaxations,
            cch_accelerated: path.cch_accelerated,
        },
        None => StreetPathResult {
            found: false,
            distance_m: 0.0,
            origin_snap_distance_m: 0.0,
            destination_snap_distance_m: 0.0,
            coordinates: Vec::new(),
            query_ns: started.elapsed().as_nanos() as f64,
            settled_nodes: 0,
            relaxed_edges: 0,
            chain_skipped_nodes: 0,
            contracted_arc_relaxations: 0,
            cch_accelerated: false,
        },
    })
}

fn flatten_path(
    snapshot: &Snapshot,
    path: &[u32],
    maximum_points: usize,
) -> napi::Result<Vec<f64>> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let node_lons = snapshot.f64_array("nodeLons")?;
    let node_lats = snapshot.f64_array("nodeLats")?;
    let stride = path.len().div_ceil(maximum_points).max(1);
    let mut coordinates = Vec::with_capacity(maximum_points.min(path.len()) * 2 + 2);
    for (index, node) in path.iter().enumerate() {
        if index != 0 && index + 1 != path.len() && index % stride != 0 {
            continue;
        }
        coordinates.push(node_lons[*node as usize]);
        coordinates.push(node_lats[*node as usize]);
    }
    Ok(coordinates)
}
