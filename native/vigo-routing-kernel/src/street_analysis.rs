use super::{Snap, snaps_for_anchor, snaps_for_coordinate};
use crate::street_snapshot::Snapshot;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::time::Instant;

const DURATION_EPSILON_MINUTES: f64 = 1e-9;
const DISTANCE_EPSILON_M: f64 = 1e-6;

#[napi(object)]
pub struct StreetSurfaceInput {
    pub bounds: Vec<f64>,
    pub width: u32,
    pub height: u32,
    pub seed_coordinates: Vec<f64>,
    pub seed_durations_minutes: Vec<f64>,
    pub maximum_walk_m: f64,
    pub walk_speed_kph: f64,
    pub maximum_duration_minutes: f64,
    pub independent_terminal_walk: bool,
    pub include_nodes: bool,
    pub node_evidence_limit: u32,
    pub include_edges: bool,
    pub edge_evidence_limit: u32,
    pub expand_bounds_to_reached_edges: bool,
}

#[napi(object)]
pub struct StreetSurfaceNode {
    pub longitude: f64,
    pub latitude: f64,
    pub duration_minutes: f64,
    pub walk_distance_m: f64,
}

#[napi(object)]
pub struct StreetSurfaceEdge {
    pub from_longitude: f64,
    pub from_latitude: f64,
    pub to_longitude: f64,
    pub to_latitude: f64,
    pub duration_minutes: f64,
    pub walk_distance_m: f64,
    pub transit_arrival_minutes: Option<f64>,
}

#[napi(object)]
pub struct StreetSurfaceResult {
    pub values: Vec<f64>,
    pub full_surface_values: Option<Vec<f64>>,
    pub full_surface_bounds: Option<Vec<f64>>,
    pub snapped_seeds: u32,
    pub settled_labels: u32,
    pub relaxed_edges: u32,
    pub retained_labels: u32,
    pub reached_pixels: u32,
    pub query_ns: f64,
    pub node_evidence: Vec<StreetSurfaceNode>,
    pub node_evidence_truncated: bool,
    pub reached_edge_count: u32,
    pub reached_edge_length_m: f64,
    pub edge_evidence: Vec<StreetSurfaceEdge>,
    pub edge_evidence_truncated: bool,
    pub edge_evidence_nodes: Option<Float64Array>,
    pub edge_evidence_endpoints: Option<Uint32Array>,
    pub edge_evidence_ids: Option<Uint32Array>,
    pub edge_evidence_durations: Option<Float64Array>,
    pub edge_evidence_walk_distances: Option<Float64Array>,
    pub edge_evidence_transit_arrivals: Option<Float64Array>,
}

#[napi(object)]
pub struct TimedConnectorInput {
    pub seed_coordinates: Vec<f64>,
    pub seed_durations_minutes: Vec<f64>,
    pub seed_maximum_walk_m: Vec<f64>,
    pub seed_indices: Vec<u32>,
    pub seed_fixed_snap: Vec<u32>,
    pub target_coordinates: Vec<f64>,
    pub default_maximum_walk_m: f64,
    pub walk_speed_kph: f64,
    pub maximum_duration_minutes: f64,
    pub include_target_matrix: bool,
}

#[napi(object)]
pub struct TimedConnectorResult {
    pub durations_minutes: Vec<f64>,
    pub walk_distances_m: Vec<f64>,
    pub seed_indices: Vec<i32>,
    pub matrix_durations_minutes: Vec<f64>,
    pub matrix_walk_distances_m: Vec<f64>,
    pub matrix_ready_pairs: u32,
    pub searches: u32,
    pub snapped_seeds: u32,
    pub snapped_targets: u32,
    pub reached_targets: u32,
    pub settled_labels: u32,
    pub relaxed_edges: u32,
    pub retained_labels: u32,
    pub aggregate_cch_accelerated: bool,
    pub aggregate_cch_query_ns: f64,
    pub matrix_cch_accelerated: bool,
    pub matrix_cch_query_ns: f64,
    pub query_ns: f64,
}

struct StreetGraph<'a> {
    node_lats: &'a [f64],
    node_lons: &'a [f64],
    edge_offsets: &'a [u32],
    edge_targets: &'a [u32],
    edge_distances_m: &'a [f64],
}

impl<'a> StreetGraph<'a> {
    fn open(snapshot: &'a Snapshot) -> napi::Result<Self> {
        Ok(Self {
            node_lats: snapshot.f64_array("nodeLats")?,
            node_lons: snapshot.f64_array("nodeLons")?,
            edge_offsets: snapshot.u32_array("edgeOffsets")?,
            edge_targets: snapshot.u32_array("edgeTargets")?,
            edge_distances_m: snapshot.f64_array("edgeDistances")?,
        })
    }
}

#[derive(Clone, Copy)]
struct AnalysisLabel {
    node: u32,
    duration_minutes: f64,
    walk_distance_m: f64,
    maximum_walk_m: f64,
    seed_index: u32,
    active: bool,
}

#[derive(Clone, Copy)]
struct SurfaceLabel {
    node: u32,
    duration_minutes: f64,
    walk_distance_m: f64,
    seed_index: u32,
    frontier_next: u32,
    active: bool,
}

#[derive(Clone, Copy)]
struct LabelQueueEntry {
    label_index: usize,
    duration_minutes: f64,
    walk_distance_m: f64,
    node: u32,
    seed_index: u32,
}

impl PartialEq for LabelQueueEntry {
    fn eq(&self, other: &Self) -> bool {
        self.label_index == other.label_index
    }
}

impl Eq for LabelQueueEntry {}

impl PartialOrd for LabelQueueEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for LabelQueueEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .duration_minutes
            .total_cmp(&self.duration_minutes)
            .then_with(|| other.walk_distance_m.total_cmp(&self.walk_distance_m))
            .then_with(|| other.node.cmp(&self.node))
            .then_with(|| other.seed_index.cmp(&self.seed_index))
            .then_with(|| other.label_index.cmp(&self.label_index))
    }
}

#[derive(Default)]
struct SearchDiagnostics {
    snapped_seeds: u32,
    settled_labels: u32,
    relaxed_edges: u32,
    retained_labels: u32,
}

fn validate_coordinate_pairs(coordinates: &[f64], count: usize, label: &str) -> napi::Result<()> {
    if coordinates.len() != count.saturating_mul(2)
        || coordinates.iter().any(|value| !value.is_finite())
    {
        return Err(Error::from_reason(format!(
            "Rust {label} coordinate arrays are inconsistent."
        )));
    }
    Ok(())
}

fn validate_common_limits(
    maximum_walk_m: f64,
    walk_speed_kph: f64,
    maximum_duration_minutes: f64,
) -> napi::Result<()> {
    if !maximum_walk_m.is_finite()
        || maximum_walk_m < 0.0
        || !walk_speed_kph.is_finite()
        || walk_speed_kph <= 0.0
        || !maximum_duration_minutes.is_finite()
        || maximum_duration_minutes <= 0.0
    {
        return Err(Error::from_reason(
            "Rust street-analysis limits must be finite and nonnegative.",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn push_surface_label(
    frontier_heads: &mut [u32],
    labels: &mut Vec<SurfaceLabel>,
    queue: &mut BinaryHeap<LabelQueueEntry>,
    seed_arrivals_minutes: &[f64],
    node: u32,
    duration_minutes: f64,
    walk_distance_m: f64,
    maximum_walk_m: f64,
    maximum_duration_minutes: f64,
    seed_arrival_minutes: f64,
    seed_index: u32,
    independent_terminal_walk: bool,
) -> bool {
    if walk_distance_m > maximum_walk_m + DISTANCE_EPSILON_M
        || duration_minutes > maximum_duration_minutes + DURATION_EPSILON_MINUTES
    {
        return false;
    }
    let mut node_label = frontier_heads[node as usize];
    while node_label != u32::MAX {
        let label = labels[node_label as usize];
        if label.active
            && if independent_terminal_walk {
                // With an independent terminal-walk budget, a label's map value is
                // the transit arrival time, not transit arrival plus walk time.
                // Earlier transit arrival and no farther walking distance therefore
                // dominate exactly; comparing total elapsed time retains labels
                // that can never improve a downstream surface cell.
                seed_arrivals_minutes[label.seed_index as usize]
                    <= seed_arrival_minutes + DURATION_EPSILON_MINUTES
                    && label.walk_distance_m <= walk_distance_m + DISTANCE_EPSILON_M
            } else {
                label.duration_minutes <= duration_minutes + DURATION_EPSILON_MINUTES
                    && label.walk_distance_m <= walk_distance_m + DISTANCE_EPSILON_M
            }
        {
            return false;
        }
        node_label = label.frontier_next;
    }
    let mut node_label = frontier_heads[node as usize];
    while node_label != u32::MAX {
        let label = &mut labels[node_label as usize];
        let dominates = label.active
            && if independent_terminal_walk {
                seed_arrival_minutes
                    <= seed_arrivals_minutes[label.seed_index as usize] + DURATION_EPSILON_MINUTES
                    && walk_distance_m <= label.walk_distance_m + DISTANCE_EPSILON_M
            } else {
                duration_minutes <= label.duration_minutes + DURATION_EPSILON_MINUTES
                    && walk_distance_m <= label.walk_distance_m + DISTANCE_EPSILON_M
            };
        if dominates {
            label.active = false;
        }
        node_label = label.frontier_next;
    }
    let label_index = labels.len();
    labels.push(SurfaceLabel {
        node,
        duration_minutes,
        walk_distance_m,
        seed_index,
        frontier_next: frontier_heads[node as usize],
        active: true,
    });
    frontier_heads[node as usize] = label_index as u32;
    queue.push(LabelQueueEntry {
        label_index,
        duration_minutes: if independent_terminal_walk {
            seed_arrival_minutes
        } else {
            duration_minutes
        },
        walk_distance_m,
        node,
        seed_index,
    });
    true
}

fn raster_cell(
    bounds: &[f64],
    width: usize,
    height: usize,
    longitude: f64,
    latitude: f64,
) -> Option<usize> {
    let [west, south, east, north] = bounds else {
        return None;
    };
    if longitude < *west || longitude > *east || latitude < *south || latitude > *north {
        return None;
    }
    let x = (((longitude - west) / (east - west) * width as f64).floor() as usize).min(width - 1);
    let y =
        (((north - latitude) / (north - south) * height as f64).floor() as usize).min(height - 1);
    Some(y * width + x)
}

#[derive(Clone, Copy)]
struct RasterSurfaceEdge {
    from_longitude: f64,
    from_latitude: f64,
    to_longitude: f64,
    to_latitude: f64,
    from_duration_minutes: f64,
    edge_duration_minutes: f64,
    maximum_duration_minutes: f64,
    constant_duration_minutes: Option<f64>,
}

fn rasterize_surface_edge(
    values: &mut [f64],
    bounds: &[f64],
    width: usize,
    height: usize,
    edge: RasterSurfaceEdge,
) {
    let RasterSurfaceEdge {
        from_longitude,
        from_latitude,
        to_longitude,
        to_latitude,
        from_duration_minutes,
        edge_duration_minutes,
        maximum_duration_minutes,
        constant_duration_minutes,
    } = edge;
    let [west, south, east, north] = bounds else {
        return;
    };
    let from_x = (from_longitude - west) / (east - west) * width as f64;
    let from_y = (north - from_latitude) / (north - south) * height as f64;
    let to_x = (to_longitude - west) / (east - west) * width as f64;
    let to_y = (north - to_latitude) / (north - south) * height as f64;
    let steps = ((to_x - from_x).abs().max((to_y - from_y).abs()).ceil() as usize)
        .saturating_mul(2)
        .max(1);
    for step in 0..=steps {
        let fraction = step as f64 / steps as f64;
        let longitude = from_longitude + (to_longitude - from_longitude) * fraction;
        let latitude = from_latitude + (to_latitude - from_latitude) * fraction;
        let duration_minutes = constant_duration_minutes
            .unwrap_or(from_duration_minutes + edge_duration_minutes * fraction);
        if duration_minutes > maximum_duration_minutes + DURATION_EPSILON_MINUTES {
            continue;
        }
        if let Some(cell) = raster_cell(bounds, width, height, longitude, latitude) {
            values[cell] = values[cell].min(duration_minutes);
        }
    }
}

fn reached_edge_bounds(
    graph: &StreetGraph<'_>,
    edge_evidence: &[SurfaceEdgeRecord],
    seed_coordinates: &[f64],
) -> Option<Vec<f64>> {
    let mut west = f64::INFINITY;
    let mut south = f64::INFINITY;
    let mut east = f64::NEG_INFINITY;
    let mut north = f64::NEG_INFINITY;
    let mut include = |longitude: f64, latitude: f64| {
        west = west.min(longitude);
        south = south.min(latitude);
        east = east.max(longitude);
        north = north.max(latitude);
    };
    if let Some(pair) = seed_coordinates.as_chunks::<2>().0.first() {
        // Keep the origin visible even when the graph has no reached edge.
        // Transit seeds are represented by their reached edge endpoints below;
        // an unsnapped seed must not create a false area pixel.
        include(pair[0], pair[1]);
    }
    for edge in edge_evidence {
        let from = edge.from_node as usize;
        let to = graph.edge_targets[edge.edge_index] as usize;
        include(graph.node_lons[from], graph.node_lats[from]);
        include(graph.node_lons[to], graph.node_lats[to]);
    }
    if !west.is_finite() || !south.is_finite() || !east.is_finite() || !north.is_finite() {
        return None;
    }
    // A one-dimensional fixture (or an origin-only surface) still needs a
    // valid raster envelope. The epsilon is only a zero-span guard; it does
    // not discard or select any reached geometry.
    let longitude_padding = if east > west { 0.0 } else { 1e-7 };
    let latitude_padding = if north > south { 0.0 } else { 1e-7 };
    Some(vec![
        west - longitude_padding,
        south - latitude_padding,
        east + longitude_padding,
        north + latitude_padding,
    ])
}

fn full_surface_raster(
    graph: &StreetGraph<'_>,
    edge_evidence: &[SurfaceEdgeRecord],
    input: &StreetSurfaceInput,
    bounds: &[f64],
    width: usize,
    height: usize,
) -> Vec<f64> {
    let mut values = vec![f64::INFINITY; width * height];
    let minutes_per_meter = 60.0 / (input.walk_speed_kph * 1000.0);
    let terminal_walk_minutes = input.maximum_walk_m * minutes_per_meter;
    if let Some(pair) = input.seed_coordinates.as_chunks::<2>().0.first()
        && let Some(cell) = raster_cell(bounds, width, height, pair[0], pair[1])
    {
        values[cell] = values[cell].min(input.seed_durations_minutes[0]);
    }
    for edge in edge_evidence {
        let from = edge.from_node as usize;
        let to = graph.edge_targets[edge.edge_index] as usize;
        let edge_duration_minutes = graph.edge_distances_m[edge.edge_index] * minutes_per_meter;
        let maximum_duration_minutes = if input.independent_terminal_walk {
            (input.seed_durations_minutes[edge.seed_index as usize] + terminal_walk_minutes)
                .min(input.maximum_duration_minutes)
        } else {
            input.maximum_duration_minutes
        };
        rasterize_surface_edge(
            &mut values,
            bounds,
            width,
            height,
            RasterSurfaceEdge {
                from_longitude: graph.node_lons[from],
                from_latitude: graph.node_lats[from],
                to_longitude: graph.node_lons[to],
                to_latitude: graph.node_lats[to],
                from_duration_minutes: (edge.duration_minutes - edge_duration_minutes).max(0.0),
                edge_duration_minutes,
                maximum_duration_minutes,
                constant_duration_minutes: if input.independent_terminal_walk {
                    Some(input.seed_durations_minutes[edge.seed_index as usize])
                } else {
                    None
                },
            },
        );
    }
    values
}

pub(super) fn street_surface(
    snapshot: &Snapshot,
    reciprocal_edge_flags: &[u8],
    input: StreetSurfaceInput,
) -> napi::Result<StreetSurfaceResult> {
    let started = Instant::now();
    if input.bounds.len() != 4
        || input.bounds.iter().any(|value| !value.is_finite())
        || input.bounds[0] >= input.bounds[2]
        || input.bounds[1] >= input.bounds[3]
        || input.width == 0
        || input.height == 0
        || input.width > 1024
        || input.height > 1024
    {
        return Err(Error::from_reason(
            "Rust street surface requires valid bounds and a raster no larger than 1024 by 1024.",
        ));
    }
    validate_common_limits(
        input.maximum_walk_m,
        input.walk_speed_kph,
        input.maximum_duration_minutes,
    )?;
    validate_coordinate_pairs(
        &input.seed_coordinates,
        input.seed_durations_minutes.len(),
        "surface seed",
    )?;
    if input
        .seed_durations_minutes
        .iter()
        .any(|duration| !duration.is_finite() || *duration < 0.0)
    {
        return Err(Error::from_reason(
            "Rust street surface seed durations must be finite and nonnegative.",
        ));
    }

    let graph = StreetGraph::open(snapshot)?;
    let width = input.width as usize;
    let height = input.height as usize;
    let mut values = vec![f64::INFINITY; width * height];
    let mut labels = Vec::<SurfaceLabel>::new();
    let mut frontier_heads = vec![u32::MAX; graph.node_lats.len()];
    let mut queue = BinaryHeap::<LabelQueueEntry>::new();
    let mut node_evidence_by_node = if input.include_nodes {
        Some(HashMap::<u32, (f64, f64)>::new())
    } else {
        None
    };
    // A byte per graph edge is enough for exact reached-edge diagnostics and
    // avoids allocating a hash entry for every edge visited by every seed.
    // The surface search can touch millions of directed edges; this stays
    // bounded by the immutable graph and keeps the query allocation flat.
    let mut reached_edge_flags = vec![0_u8; graph.edge_targets.len()];
    let mut reached_edge_count = 0_u32;
    let mut reached_edge_length_m = 0.0_f64;
    let edge_evidence_limit = if input.edge_evidence_limit == 0 {
        None
    } else {
        Some(input.edge_evidence_limit.clamp(1, 100_000) as usize)
    };
    let bounded_edge_limit = edge_evidence_limit.unwrap_or(0);
    let full_edge_evidence = input.include_edges && edge_evidence_limit.is_none();
    let retain_full_surface_edges =
        input.expand_bounds_to_reached_edges && edge_evidence_limit.is_none();
    // The bounded mode is retained for callers that explicitly request a
    // positive edge-evidence limit. The zero-limit mode is the exact full-map
    // contract used by accessibility rendering and must retain every reached
    // directed edge.
    let bounded_early_edge_evidence =
        input.include_edges && input.independent_terminal_walk && edge_evidence_limit.is_some();
    let mut bounded_edge_evidence = if bounded_early_edge_evidence {
        Some(Vec::<SurfaceEdgeRecord>::with_capacity(bounded_edge_limit))
    } else {
        None
    };
    let mut full_edge_indices = if full_edge_evidence || retain_full_surface_edges {
        Some(vec![u32::MAX; graph.edge_targets.len()])
    } else {
        None
    };
    let mut full_edge_records = if full_edge_evidence || retain_full_surface_edges {
        Some(Vec::<SurfaceEdgeRecord>::new())
    } else {
        None
    };
    let mut edge_evidence_by_edge =
        if input.include_edges && !bounded_early_edge_evidence && !full_edge_evidence {
            Some(HashMap::<usize, SurfaceEdgeRecord>::new())
        } else {
            None
        };
    let mut diagnostics = SearchDiagnostics::default();
    let minutes_per_meter = 60.0 / (input.walk_speed_kph * 1000.0);
    let terminal_walk_minutes = input.maximum_walk_m * minutes_per_meter;

    let mut seed_order = (0..input.seed_durations_minutes.len()).collect::<Vec<_>>();
    seed_order.sort_by(|left, right| {
        input.seed_durations_minutes[*left]
            .total_cmp(&input.seed_durations_minutes[*right])
            .then_with(|| left.cmp(right))
    });
    let mut next_seed = 0_usize;
    if !input.independent_terminal_walk {
        for seed in 0..input.seed_durations_minutes.len() {
            let longitude = input.seed_coordinates[seed * 2];
            let latitude = input.seed_coordinates[seed * 2 + 1];
            for snap in snaps_for_anchor(snapshot, reciprocal_edge_flags, longitude, latitude)? {
                let retained = push_surface_label(
                    &mut frontier_heads,
                    &mut labels,
                    &mut queue,
                    &input.seed_durations_minutes,
                    snap.node,
                    input.seed_durations_minutes[seed] + snap.distance_m * minutes_per_meter,
                    snap.distance_m,
                    input.maximum_walk_m,
                    input.maximum_duration_minutes,
                    input.seed_durations_minutes[seed],
                    seed as u32,
                    false,
                );
                if retained {
                    diagnostics.snapped_seeds = diagnostics.snapped_seeds.saturating_add(1);
                    diagnostics.retained_labels = diagnostics.retained_labels.saturating_add(1);
                }
            }
        }
        next_seed = seed_order.len();
    }

    while next_seed < seed_order.len() || !queue.is_empty() {
        // Independent terminal-walk dominance is monotone in transit arrival:
        // finish one arrival-time group before introducing a later group. This
        // keeps the heap bounded to the active group and prevents labels that
        // are guaranteed to be dominated from being settled first.
        if input.independent_terminal_walk && queue.is_empty() && next_seed < seed_order.len() {
            let first_seed = seed_order[next_seed];
            let group_arrival = input.seed_durations_minutes[first_seed];
            while next_seed < seed_order.len()
                && (input.seed_durations_minutes[seed_order[next_seed]] - group_arrival).abs()
                    <= DURATION_EPSILON_MINUTES
            {
                let seed = seed_order[next_seed];
                let longitude = input.seed_coordinates[seed * 2];
                let latitude = input.seed_coordinates[seed * 2 + 1];
                let maximum_duration_minutes = if input.independent_terminal_walk {
                    (input.seed_durations_minutes[seed] + terminal_walk_minutes)
                        .min(input.maximum_duration_minutes)
                } else {
                    input.maximum_duration_minutes
                };
                for snap in snaps_for_anchor(snapshot, reciprocal_edge_flags, longitude, latitude)?
                {
                    let retained = push_surface_label(
                        &mut frontier_heads,
                        &mut labels,
                        &mut queue,
                        &input.seed_durations_minutes,
                        snap.node,
                        input.seed_durations_minutes[seed] + snap.distance_m * minutes_per_meter,
                        snap.distance_m,
                        input.maximum_walk_m,
                        maximum_duration_minutes,
                        input.seed_durations_minutes[seed],
                        seed as u32,
                        input.independent_terminal_walk,
                    );
                    if retained {
                        diagnostics.snapped_seeds = diagnostics.snapped_seeds.saturating_add(1);
                        diagnostics.retained_labels = diagnostics.retained_labels.saturating_add(1);
                    }
                }
                next_seed += 1;
            }
        }

        let Some(entry) = queue.pop() else {
            continue;
        };
        if !labels[entry.label_index].active {
            continue;
        }
        let current = labels[entry.label_index];
        diagnostics.settled_labels = diagnostics.settled_labels.saturating_add(1);
        let current_maximum_duration_minutes = if input.independent_terminal_walk {
            (input.seed_durations_minutes[current.seed_index as usize] + terminal_walk_minutes)
                .min(input.maximum_duration_minutes)
        } else {
            input.maximum_duration_minutes
        };
        if let Some(cell) = raster_cell(
            &input.bounds,
            width,
            height,
            graph.node_lons[current.node as usize],
            graph.node_lats[current.node as usize],
        ) {
            let surface_duration_minutes = if input.independent_terminal_walk {
                input.seed_durations_minutes[current.seed_index as usize]
            } else {
                current.duration_minutes
            };
            values[cell] = values[cell].min(surface_duration_minutes);
            if let Some(evidence) = node_evidence_by_node.as_mut() {
                let retained = evidence
                    .entry(current.node)
                    .or_insert((current.duration_minutes, current.walk_distance_m));
                if current.duration_minutes + DURATION_EPSILON_MINUTES < retained.0
                    || (current.duration_minutes - retained.0).abs() <= DURATION_EPSILON_MINUTES
                        && current.walk_distance_m + DISTANCE_EPSILON_M < retained.1
                {
                    *retained = (current.duration_minutes, current.walk_distance_m);
                }
            }
        }
        let node = current.node as usize;
        for edge in graph.edge_offsets[node] as usize..graph.edge_offsets[node + 1] as usize {
            diagnostics.relaxed_edges = diagnostics.relaxed_edges.saturating_add(1);
            let distance_m = graph.edge_distances_m[edge];
            let edge_duration_minutes = distance_m * minutes_per_meter;
            let candidate_duration_minutes = current.duration_minutes + edge_duration_minutes;
            let candidate_walk_distance_m = current.walk_distance_m + distance_m;
            if current.walk_distance_m + distance_m <= input.maximum_walk_m + DISTANCE_EPSILON_M
                && candidate_duration_minutes
                    <= current_maximum_duration_minutes + DURATION_EPSILON_MINUTES
            {
                if reached_edge_flags[edge] == 0 {
                    reached_edge_flags[edge] = 1;
                    reached_edge_count = reached_edge_count.saturating_add(1);
                    reached_edge_length_m += distance_m;
                    if let Some(edge_evidence) = bounded_edge_evidence.as_mut()
                        && edge_evidence.len() < bounded_edge_limit
                    {
                        edge_evidence.push(SurfaceEdgeRecord {
                            edge_index: edge,
                            from_node: node as u32,
                            duration_minutes: candidate_duration_minutes,
                            walk_distance_m: candidate_walk_distance_m,
                            seed_index: current.seed_index,
                        });
                    }
                }
                let candidate = SurfaceEdgeRecord {
                    edge_index: edge,
                    from_node: node as u32,
                    duration_minutes: candidate_duration_minutes,
                    walk_distance_m: candidate_walk_distance_m,
                    seed_index: current.seed_index,
                };
                if let (Some(edge_indices), Some(edge_records)) =
                    (full_edge_indices.as_mut(), full_edge_records.as_mut())
                {
                    let record_index = edge_indices[edge];
                    if record_index == u32::MAX {
                        edge_indices[edge] = edge_records.len() as u32;
                        edge_records.push(candidate);
                    } else {
                        let existing = &mut edge_records[record_index as usize];
                        let better = if input.independent_terminal_walk {
                            let candidate_arrival =
                                input.seed_durations_minutes[candidate.seed_index as usize];
                            let existing_arrival =
                                input.seed_durations_minutes[existing.seed_index as usize];
                            candidate_arrival < existing_arrival - DURATION_EPSILON_MINUTES
                                || (candidate_arrival - existing_arrival).abs()
                                    <= DURATION_EPSILON_MINUTES
                                    && candidate.walk_distance_m
                                        < existing.walk_distance_m - DISTANCE_EPSILON_M
                        } else {
                            candidate.duration_minutes
                                < existing.duration_minutes - DURATION_EPSILON_MINUTES
                                || (candidate.duration_minutes - existing.duration_minutes).abs()
                                    <= DURATION_EPSILON_MINUTES
                                    && candidate.walk_distance_m
                                        < existing.walk_distance_m - DISTANCE_EPSILON_M
                        };
                        if better {
                            *existing = candidate;
                        }
                    }
                } else if let Some(edge_evidence) = edge_evidence_by_edge.as_mut() {
                    let replace = edge_evidence
                        .get(&edge)
                        .map(|existing| {
                            if input.independent_terminal_walk {
                                let candidate_arrival =
                                    input.seed_durations_minutes[candidate.seed_index as usize];
                                let existing_arrival =
                                    input.seed_durations_minutes[existing.seed_index as usize];
                                candidate_arrival < existing_arrival - DURATION_EPSILON_MINUTES
                                    || (candidate_arrival - existing_arrival).abs()
                                        <= DURATION_EPSILON_MINUTES
                                        && candidate.walk_distance_m
                                            < existing.walk_distance_m - DISTANCE_EPSILON_M
                            } else {
                                candidate.duration_minutes
                                    < existing.duration_minutes - DURATION_EPSILON_MINUTES
                                    || (candidate.duration_minutes - existing.duration_minutes)
                                        .abs()
                                        <= DURATION_EPSILON_MINUTES
                                        && candidate.walk_distance_m
                                            < existing.walk_distance_m - DISTANCE_EPSILON_M
                            }
                        })
                        .unwrap_or(true);
                    if replace {
                        edge_evidence.insert(edge, candidate);
                    }
                }
                rasterize_surface_edge(
                    &mut values,
                    &input.bounds,
                    width,
                    height,
                    RasterSurfaceEdge {
                        from_longitude: graph.node_lons[node],
                        from_latitude: graph.node_lats[node],
                        to_longitude: graph.node_lons[graph.edge_targets[edge] as usize],
                        to_latitude: graph.node_lats[graph.edge_targets[edge] as usize],
                        from_duration_minutes: current.duration_minutes,
                        edge_duration_minutes,
                        maximum_duration_minutes: current_maximum_duration_minutes,
                        constant_duration_minutes: if input.independent_terminal_walk {
                            Some(input.seed_durations_minutes[current.seed_index as usize])
                        } else {
                            None
                        },
                    },
                );
                if push_surface_label(
                    &mut frontier_heads,
                    &mut labels,
                    &mut queue,
                    &input.seed_durations_minutes,
                    graph.edge_targets[edge],
                    candidate_duration_minutes,
                    candidate_walk_distance_m,
                    input.maximum_walk_m,
                    current_maximum_duration_minutes,
                    input.seed_durations_minutes[current.seed_index as usize],
                    current.seed_index,
                    input.independent_terminal_walk,
                ) {
                    diagnostics.retained_labels = diagnostics.retained_labels.saturating_add(1);
                }
            }
        }
    }

    let node_evidence_limit = input.node_evidence_limit.clamp(1, 100_000) as usize;
    let mut node_evidence = node_evidence_by_node
        .unwrap_or_default()
        .into_iter()
        .map(
            |(node, (duration_minutes, walk_distance_m))| StreetSurfaceNode {
                longitude: graph.node_lons[node as usize],
                latitude: graph.node_lats[node as usize],
                duration_minutes,
                walk_distance_m,
            },
        )
        .collect::<Vec<_>>();
    node_evidence.sort_by(|left, right| {
        left.duration_minutes
            .total_cmp(&right.duration_minutes)
            .then_with(|| left.walk_distance_m.total_cmp(&right.walk_distance_m))
            .then_with(|| left.latitude.total_cmp(&right.latitude))
            .then_with(|| left.longitude.total_cmp(&right.longitude))
    });
    let node_evidence_truncated = node_evidence.len() > node_evidence_limit;
    node_evidence.truncate(node_evidence_limit);
    // A zero limit is the explicit full-map geometry mode. It uses a compact
    // edge-indexed record table above instead of a hash entry per reached edge.
    let mut edge_evidence = bounded_edge_evidence.unwrap_or_else(|| {
        full_edge_records.unwrap_or_else(|| {
            edge_evidence_by_edge
                .unwrap_or_default()
                .into_values()
                .collect::<Vec<_>>()
        })
    });
    if full_edge_evidence || retain_full_surface_edges {
        // Full bundles are joined across baseline/scenario by the immutable
        // directed graph edge ID. Sorting by that ID makes the browser join a
        // linear merge with no per-edge string keys or lookup maps.
        edge_evidence.sort_by_key(|edge| edge.edge_index);
    } else {
        edge_evidence.sort_by(|left, right| {
            left.duration_minutes
                .total_cmp(&right.duration_minutes)
                .then_with(|| left.walk_distance_m.total_cmp(&right.walk_distance_m))
                .then_with(|| left.seed_index.cmp(&right.seed_index))
                .then_with(|| left.edge_index.cmp(&right.edge_index))
        });
    }
    let edge_evidence_truncated = edge_evidence_limit.is_some_and(|limit| {
        if bounded_early_edge_evidence {
            reached_edge_count as usize > limit
        } else {
            edge_evidence.len() > limit
        }
    });
    if let Some(limit) = edge_evidence_limit {
        edge_evidence.truncate(limit);
    }
    let (full_surface_values, full_surface_bounds) = if retain_full_surface_edges {
        let bounds = reached_edge_bounds(&graph, &edge_evidence, &input.seed_coordinates);
        let values = bounds.as_ref().map(|bounds| {
            full_surface_raster(&graph, &edge_evidence, &input, bounds, width, height)
        });
        (values, bounds)
    } else {
        (None, None)
    };
    let reached_pixels = values
        .iter()
        .filter(|duration| duration.is_finite() && **duration <= input.maximum_duration_minutes)
        .count() as u32;
    let (
        edge_evidence,
        edge_evidence_nodes,
        edge_evidence_endpoints,
        edge_evidence_ids,
        edge_evidence_durations,
        edge_evidence_walk_distances,
        edge_evidence_transit_arrivals,
    ) = if full_edge_evidence {
        // Keep the full-mode result typed and indexed across the N-API
        // boundary. This avoids allocating one JavaScript object and four
        // coordinate numbers for every reached edge before the server packs
        // the response.
        let mut node_ids = HashMap::<u32, u32>::new();
        let mut node_coordinates = Vec::<f64>::new();
        let mut endpoints = Vec::<u32>::with_capacity(edge_evidence.len() * 2);
        let mut edge_ids = Vec::<u32>::with_capacity(edge_evidence.len());
        let mut durations = Vec::<f64>::with_capacity(edge_evidence.len());
        let mut walk_distances = Vec::<f64>::with_capacity(edge_evidence.len());
        let mut transit_arrivals = Vec::<f64>::with_capacity(edge_evidence.len());
        let mut local_node = |node: u32| -> u32 {
            if let Some(index) = node_ids.get(&node) {
                return *index;
            }
            let index = (node_coordinates.len() / 2) as u32;
            node_ids.insert(node, index);
            node_coordinates.push(graph.node_lons[node as usize]);
            node_coordinates.push(graph.node_lats[node as usize]);
            index
        };
        for edge in &edge_evidence {
            let from_node = edge.from_node;
            let to_node = graph.edge_targets[edge.edge_index];
            endpoints.push(local_node(from_node));
            endpoints.push(local_node(to_node));
            edge_ids.push(edge.edge_index as u32);
            durations.push(edge.duration_minutes);
            walk_distances.push(edge.walk_distance_m);
            transit_arrivals.push(if edge.seed_index == 0 {
                -1.0
            } else {
                input
                    .seed_durations_minutes
                    .get(edge.seed_index as usize)
                    .copied()
                    .unwrap_or(-1.0)
            });
        }
        (
            Vec::new(),
            Some(Float64Array::from(node_coordinates)),
            Some(Uint32Array::from(endpoints)),
            Some(Uint32Array::from(edge_ids)),
            Some(Float64Array::from(durations)),
            Some(Float64Array::from(walk_distances)),
            Some(Float64Array::from(transit_arrivals)),
        )
    } else if input.include_edges {
        let materialized = edge_evidence
            .into_iter()
            .map(|edge| {
                let from_node = edge.from_node as usize;
                let to_node = graph.edge_targets[edge.edge_index] as usize;
                StreetSurfaceEdge {
                    from_longitude: graph.node_lons[from_node],
                    from_latitude: graph.node_lats[from_node],
                    to_longitude: graph.node_lons[to_node],
                    to_latitude: graph.node_lats[to_node],
                    duration_minutes: edge.duration_minutes,
                    walk_distance_m: edge.walk_distance_m,
                    transit_arrival_minutes: if edge.seed_index == 0 {
                        None
                    } else {
                        input
                            .seed_durations_minutes
                            .get(edge.seed_index as usize)
                            .copied()
                    },
                }
            })
            .collect::<Vec<_>>();
        (materialized, None, None, None, None, None, None)
    } else {
        (Vec::new(), None, None, None, None, None, None)
    };
    Ok(StreetSurfaceResult {
        values,
        full_surface_values,
        full_surface_bounds,
        snapped_seeds: diagnostics.snapped_seeds,
        settled_labels: diagnostics.settled_labels,
        relaxed_edges: diagnostics.relaxed_edges,
        retained_labels: diagnostics.retained_labels,
        reached_pixels,
        query_ns: started.elapsed().as_nanos() as f64,
        node_evidence,
        node_evidence_truncated,
        reached_edge_count,
        reached_edge_length_m,
        edge_evidence,
        edge_evidence_truncated,
        edge_evidence_nodes,
        edge_evidence_endpoints,
        edge_evidence_ids,
        edge_evidence_durations,
        edge_evidence_walk_distances,
        edge_evidence_transit_arrivals,
    })
}

#[derive(Clone, Copy)]
struct SurfaceEdgeRecord {
    edge_index: usize,
    from_node: u32,
    duration_minutes: f64,
    walk_distance_m: f64,
    seed_index: u32,
}

#[derive(Clone, Copy)]
struct ConnectorTarget {
    target_index: usize,
    snap_distance_m: f64,
}

struct PreparedConnectorTargets {
    entries_by_node: HashMap<u32, Vec<ConnectorTarget>>,
    snaps_by_target: Vec<Vec<Snap>>,
    coordinates: Vec<(f64, f64)>,
    snapped_targets: u32,
}

fn prepare_connector_targets(
    snapshot: &Snapshot,
    reciprocal_edge_flags: &[u8],
    coordinates: &[f64],
) -> napi::Result<PreparedConnectorTargets> {
    let target_count = coordinates.len() / 2;
    let mut entries_by_node = HashMap::<u32, Vec<ConnectorTarget>>::new();
    let mut snaps_by_target = Vec::with_capacity(target_count);
    let mut normalized_coordinates = Vec::with_capacity(target_count);
    let mut snapped_targets = 0_u32;
    for target_index in 0..target_count {
        let longitude = coordinates[target_index * 2];
        let latitude = coordinates[target_index * 2 + 1];
        let snaps = snaps_for_coordinate(snapshot, reciprocal_edge_flags, longitude, latitude)?;
        if !snaps.is_empty() {
            snapped_targets = snapped_targets.saturating_add(1);
        }
        for snap in &snaps {
            entries_by_node
                .entry(snap.node)
                .or_default()
                .push(ConnectorTarget {
                    target_index,
                    snap_distance_m: snap.distance_m,
                });
        }
        snaps_by_target.push(snaps);
        normalized_coordinates.push((longitude, latitude));
    }
    Ok(PreparedConnectorTargets {
        entries_by_node,
        snaps_by_target,
        coordinates: normalized_coordinates,
        snapped_targets,
    })
}

struct ConnectorSeed {
    longitude: f64,
    latitude: f64,
    duration_minutes: f64,
    maximum_walk_m: f64,
    seed_index: u32,
    snaps: Vec<Snap>,
}

struct ConnectorSearchResult {
    durations_minutes: Vec<f64>,
    walk_distances_m: Vec<f64>,
    seed_indices: Vec<i32>,
    diagnostics: SearchDiagnostics,
}

fn push_connector_label(
    frontier: &mut HashMap<u32, Vec<usize>>,
    labels: &mut Vec<AnalysisLabel>,
    queue: &mut BinaryHeap<LabelQueueEntry>,
    candidate: AnalysisLabel,
    maximum_duration_minutes: f64,
) -> bool {
    if candidate.walk_distance_m > candidate.maximum_walk_m + DISTANCE_EPSILON_M
        || candidate.duration_minutes > maximum_duration_minutes + DURATION_EPSILON_MINUTES
    {
        return false;
    }
    let remaining_walk_m = candidate.maximum_walk_m - candidate.walk_distance_m;
    let node_labels = frontier.entry(candidate.node).or_default();
    if node_labels.iter().any(|index| {
        let label = labels[*index];
        label.active
            && label.duration_minutes <= candidate.duration_minutes + DURATION_EPSILON_MINUTES
            && label.maximum_walk_m - label.walk_distance_m >= remaining_walk_m - DISTANCE_EPSILON_M
    }) {
        return false;
    }
    for &index in node_labels.iter() {
        let label = &mut labels[index];
        if label.active
            && candidate.duration_minutes <= label.duration_minutes + DURATION_EPSILON_MINUTES
            && remaining_walk_m >= label.maximum_walk_m - label.walk_distance_m - DISTANCE_EPSILON_M
        {
            label.active = false;
        }
    }
    let label_index = labels.len();
    labels.push(candidate);
    node_labels.push(label_index);
    queue.push(LabelQueueEntry {
        label_index,
        duration_minutes: candidate.duration_minutes,
        walk_distance_m: candidate.walk_distance_m,
        node: candidate.node,
        seed_index: candidate.seed_index,
    });
    true
}

fn better_connector_arrival(
    duration_minutes: f64,
    walk_distance_m: f64,
    seed_index: u32,
    previous_duration_minutes: f64,
    previous_walk_distance_m: f64,
    previous_seed_index: i32,
) -> bool {
    if duration_minutes < previous_duration_minutes - DURATION_EPSILON_MINUTES {
        return true;
    }
    if (duration_minutes - previous_duration_minutes).abs() > DURATION_EPSILON_MINUTES {
        return false;
    }
    if walk_distance_m < previous_walk_distance_m - DISTANCE_EPSILON_M {
        return true;
    }
    (walk_distance_m - previous_walk_distance_m).abs() <= DISTANCE_EPSILON_M
        && (previous_seed_index < 0 || seed_index < previous_seed_index as u32)
}

fn update_connector_target(
    result: &mut ConnectorSearchResult,
    target_index: usize,
    duration_minutes: f64,
    walk_distance_m: f64,
    seed_index: u32,
    maximum_duration_minutes: f64,
) {
    if duration_minutes > maximum_duration_minutes + DURATION_EPSILON_MINUTES
        || !better_connector_arrival(
            duration_minutes,
            walk_distance_m,
            seed_index,
            result.durations_minutes[target_index],
            result.walk_distances_m[target_index],
            result.seed_indices[target_index],
        )
    {
        return;
    }
    result.durations_minutes[target_index] = duration_minutes;
    result.walk_distances_m[target_index] = walk_distance_m;
    result.seed_indices[target_index] = seed_index as i32;
}

fn run_connector_search(
    graph: &StreetGraph<'_>,
    seeds: &[ConnectorSeed],
    targets: &PreparedConnectorTargets,
    minutes_per_meter: f64,
    maximum_duration_minutes: f64,
) -> ConnectorSearchResult {
    let target_count = targets.coordinates.len();
    let mut result = ConnectorSearchResult {
        durations_minutes: vec![f64::INFINITY; target_count],
        walk_distances_m: vec![f64::INFINITY; target_count],
        seed_indices: vec![-1; target_count],
        diagnostics: SearchDiagnostics::default(),
    };
    let mut labels = Vec::<AnalysisLabel>::new();
    let mut frontier = HashMap::<u32, Vec<usize>>::new();
    let mut queue = BinaryHeap::<LabelQueueEntry>::new();

    for seed in seeds {
        for (target_index, &(longitude, latitude)) in targets.coordinates.iter().enumerate() {
            if seed.longitude == longitude && seed.latitude == latitude {
                update_connector_target(
                    &mut result,
                    target_index,
                    seed.duration_minutes,
                    0.0,
                    seed.seed_index,
                    maximum_duration_minutes,
                );
            }
        }
        for snap in &seed.snaps {
            let candidate = AnalysisLabel {
                node: snap.node,
                duration_minutes: seed.duration_minutes + snap.distance_m * minutes_per_meter,
                walk_distance_m: snap.distance_m,
                maximum_walk_m: seed.maximum_walk_m,
                seed_index: seed.seed_index,
                active: true,
            };
            if push_connector_label(
                &mut frontier,
                &mut labels,
                &mut queue,
                candidate,
                maximum_duration_minutes,
            ) {
                result.diagnostics.snapped_seeds =
                    result.diagnostics.snapped_seeds.saturating_add(1);
                result.diagnostics.retained_labels =
                    result.diagnostics.retained_labels.saturating_add(1);
            }
        }
    }

    while let Some(entry) = queue.pop() {
        if !labels[entry.label_index].active {
            continue;
        }
        let current = labels[entry.label_index];
        result.diagnostics.settled_labels = result.diagnostics.settled_labels.saturating_add(1);
        if let Some(target_entries) = targets.entries_by_node.get(&current.node) {
            for target in target_entries {
                let walk_distance_m = current.walk_distance_m + target.snap_distance_m;
                if walk_distance_m > current.maximum_walk_m + DISTANCE_EPSILON_M {
                    continue;
                }
                update_connector_target(
                    &mut result,
                    target.target_index,
                    current.duration_minutes + target.snap_distance_m * minutes_per_meter,
                    walk_distance_m,
                    current.seed_index,
                    maximum_duration_minutes,
                );
            }
        }
        let node = current.node as usize;
        for edge in graph.edge_offsets[node] as usize..graph.edge_offsets[node + 1] as usize {
            result.diagnostics.relaxed_edges = result.diagnostics.relaxed_edges.saturating_add(1);
            let distance_m = graph.edge_distances_m[edge];
            let candidate = AnalysisLabel {
                node: graph.edge_targets[edge],
                duration_minutes: current.duration_minutes + distance_m * minutes_per_meter,
                walk_distance_m: current.walk_distance_m + distance_m,
                maximum_walk_m: current.maximum_walk_m,
                seed_index: current.seed_index,
                active: true,
            };
            if push_connector_label(
                &mut frontier,
                &mut labels,
                &mut queue,
                candidate,
                maximum_duration_minutes,
            ) {
                result.diagnostics.retained_labels =
                    result.diagnostics.retained_labels.saturating_add(1);
            }
        }
    }
    result
}

pub(super) fn validate_timed_connector_input(
    input: &TimedConnectorInput,
) -> napi::Result<(usize, usize)> {
    let seed_count = input.seed_durations_minutes.len();
    let target_count = input.target_coordinates.len() / 2;
    validate_coordinate_pairs(&input.seed_coordinates, seed_count, "connector seed")?;
    validate_coordinate_pairs(&input.target_coordinates, target_count, "connector target")?;
    if input.seed_maximum_walk_m.len() != seed_count
        || input.seed_indices.len() != seed_count
        || input.seed_fixed_snap.len() != seed_count
        || input.seed_durations_minutes.iter().any(|duration| {
            !duration.is_finite() || *duration < 0.0 || *duration > input.maximum_duration_minutes
        })
        || input
            .seed_maximum_walk_m
            .iter()
            .any(|distance| !distance.is_finite() || *distance < 0.0)
    {
        return Err(Error::from_reason(
            "Rust timed-connector seed arrays are inconsistent.",
        ));
    }
    if target_count > 256 && input.include_target_matrix {
        return Err(Error::from_reason(
            "Directed street connector matrices are limited to 256 targets.",
        ));
    }
    validate_common_limits(
        input.default_maximum_walk_m,
        input.walk_speed_kph,
        input.maximum_duration_minutes,
    )?;
    Ok((seed_count, target_count))
}

pub(super) fn timed_connectors(
    snapshot: &Snapshot,
    reciprocal_edge_flags: &[u8],
    input: TimedConnectorInput,
) -> napi::Result<TimedConnectorResult> {
    let started = Instant::now();
    let (seed_count, target_count) = validate_timed_connector_input(&input)?;

    let graph = StreetGraph::open(snapshot)?;
    let targets =
        prepare_connector_targets(snapshot, reciprocal_edge_flags, &input.target_coordinates)?;
    let mut seeds = Vec::with_capacity(seed_count);
    for seed in 0..seed_count {
        let longitude = input.seed_coordinates[seed * 2];
        let latitude = input.seed_coordinates[seed * 2 + 1];
        let snaps = if input.seed_fixed_snap[seed] != 0 {
            snaps_for_coordinate(snapshot, reciprocal_edge_flags, longitude, latitude)?
        } else {
            snaps_for_anchor(snapshot, reciprocal_edge_flags, longitude, latitude)?
        };
        seeds.push(ConnectorSeed {
            longitude,
            latitude,
            duration_minutes: input.seed_durations_minutes[seed],
            maximum_walk_m: input.seed_maximum_walk_m[seed],
            seed_index: input.seed_indices[seed],
            snaps,
        });
    }
    let minutes_per_meter = 60.0 / (input.walk_speed_kph * 1000.0);
    let aggregate = run_connector_search(
        &graph,
        &seeds,
        &targets,
        minutes_per_meter,
        input.maximum_duration_minutes,
    );
    let reached_targets = aggregate
        .durations_minutes
        .iter()
        .filter(|duration| duration.is_finite())
        .count() as u32;

    let matrix_results = if input.include_target_matrix {
        (0..target_count)
            .into_par_iter()
            .map(|source| {
                let (longitude, latitude) = targets.coordinates[source];
                let source_seed = ConnectorSeed {
                    longitude,
                    latitude,
                    duration_minutes: 0.0,
                    maximum_walk_m: input.default_maximum_walk_m,
                    seed_index: source as u32,
                    snaps: targets.snaps_by_target[source].clone(),
                };
                run_connector_search(
                    &graph,
                    std::slice::from_ref(&source_seed),
                    &targets,
                    minutes_per_meter,
                    input.maximum_duration_minutes,
                )
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let mut matrix_durations_minutes = Vec::new();
    let mut matrix_walk_distances_m = Vec::new();
    let mut matrix_ready_pairs = 0_u32;
    let mut totals = SearchDiagnostics {
        snapped_seeds: aggregate.diagnostics.snapped_seeds,
        settled_labels: aggregate.diagnostics.settled_labels,
        relaxed_edges: aggregate.diagnostics.relaxed_edges,
        retained_labels: aggregate.diagnostics.retained_labels,
    };
    for (source, mut search) in matrix_results.into_iter().enumerate() {
        search.durations_minutes[source] = 0.0;
        search.walk_distances_m[source] = 0.0;
        search.seed_indices[source] = source as i32;
        matrix_ready_pairs = matrix_ready_pairs.saturating_add(
            search
                .durations_minutes
                .iter()
                .filter(|duration| duration.is_finite())
                .count() as u32,
        );
        matrix_durations_minutes.extend(search.durations_minutes);
        matrix_walk_distances_m.extend(search.walk_distances_m);
        totals.snapped_seeds = totals
            .snapped_seeds
            .saturating_add(search.diagnostics.snapped_seeds);
        totals.settled_labels = totals
            .settled_labels
            .saturating_add(search.diagnostics.settled_labels);
        totals.relaxed_edges = totals
            .relaxed_edges
            .saturating_add(search.diagnostics.relaxed_edges);
        totals.retained_labels = totals
            .retained_labels
            .saturating_add(search.diagnostics.retained_labels);
    }

    Ok(TimedConnectorResult {
        durations_minutes: aggregate.durations_minutes,
        walk_distances_m: aggregate.walk_distances_m,
        seed_indices: aggregate.seed_indices,
        matrix_durations_minutes,
        matrix_walk_distances_m,
        matrix_ready_pairs,
        searches: 1_u32.saturating_add(if input.include_target_matrix {
            target_count as u32
        } else {
            0
        }),
        snapped_seeds: totals.snapped_seeds,
        snapped_targets: targets.snapped_targets,
        reached_targets,
        settled_labels: totals.settled_labels,
        relaxed_edges: totals.relaxed_edges,
        retained_labels: totals.retained_labels,
        aggregate_cch_accelerated: false,
        aggregate_cch_query_ns: 0.0,
        matrix_cch_accelerated: false,
        matrix_cch_query_ns: 0.0,
        query_ns: started.elapsed().as_nanos() as f64,
    })
}
