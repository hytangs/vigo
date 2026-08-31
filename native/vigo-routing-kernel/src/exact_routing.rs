use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const DRIVE_SNAP_SPEED_MPS: f64 = 20.0 / 3.6;
const EPSILON: f64 = 1e-9;
const NO_INDEX: i32 = -1;
const MAX_DRIVE_LABELS: usize = 8_000_000;
const RETAINED_DRIVE_LABEL_CAPACITY: usize = 262_144;
const DRIVE_TIME_UNITS_PER_SECOND: f64 = 100.0;
const DRIVE_DISTANCE_UNITS_PER_METER: f64 = 100.0;

#[derive(Clone, Copy)]
struct MinEntry {
    key: f64,
    item: u32,
}

impl PartialEq for MinEntry {
    fn eq(&self, other: &Self) -> bool {
        self.item == other.item && self.key.to_bits() == other.key.to_bits()
    }
}

impl Eq for MinEntry {}

impl PartialOrd for MinEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for MinEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .key
            .total_cmp(&self.key)
            .then_with(|| other.item.cmp(&self.item))
    }
}

#[inline(always)]
fn drive_value_better(
    candidate_time: f64,
    candidate_distance: f64,
    current_time: f64,
    current_distance: f64,
) -> bool {
    candidate_time < current_time - EPSILON
        || ((candidate_time - current_time).abs() <= EPSILON
            && candidate_distance < current_distance - EPSILON)
}

fn drive_weight(value: f64, units_per_value: f64, label: &str) -> napi::Result<u32> {
    let scaled = (value * units_per_value).round();
    if !scaled.is_finite() || scaled < 0.0 || scaled >= f64::from(cch::INF_WEIGHT) {
        return Err(Error::from_reason(format!(
            "{label} exceeds the exact fixed-point CCH domain.",
        )));
    }
    Ok(scaled as u32)
}

fn temporary_drive_cch_path(path: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        nonce,
    ))
}

struct PersistedDriveCch {
    // Drop the reusable query before its boxed view, and the view before the
    // immutable mmap owners it borrows.
    path_query: Option<cch::PathQuery<'static>>,
    path_view: Option<Box<cch::CchView<'static>>>,
    structure: cch::CchBundle,
    time_metric: cch::MetricBundle,
    distance_metric: cch::MetricBundle,
    structure_path: PathBuf,
    customization_structure: Option<cch::Cch>,
    traffic_metric: Option<cch::Metric>,
    traffic_active: bool,
    source: String,
}

impl PersistedDriveCch {
    fn prepare_path_query(&mut self) {
        if self.path_query.is_some() {
            return;
        }
        // SAFETY: the view contains slices into immutable mmap pages. The Box
        // gives the view a stable address, and field order guarantees that the
        // borrowing PathQuery is dropped before the view and mmap owners.
        let view = unsafe {
            std::mem::transmute::<cch::CchView<'_>, cch::CchView<'static>>(self.structure.view())
        };
        self.path_view = Some(Box::new(view));
        let view_pointer = self
            .path_view
            .as_deref()
            .expect("drive CCH path view was just installed")
            as *const cch::CchView<'static>;
        // SAFETY: view_pointer addresses the Box retained by this object.
        let static_view = unsafe { &*view_pointer };
        self.path_query = Some(cch::PathQuery::new(static_view));
    }

    fn path(&mut self, minimize_distance: bool, source: u32, target: u32) -> Option<Vec<u32>> {
        self.prepare_path_query();
        let Self {
            path_query,
            time_metric,
            distance_metric,
            traffic_metric,
            traffic_active,
            ..
        } = self;
        let metric = if minimize_distance {
            distance_metric.view()
        } else if *traffic_active {
            traffic_metric
                .as_ref()
                .expect("active drive traffic metric was customized")
                .view()
        } else {
            time_metric.view()
        };
        path_query
            .as_mut()
            .expect("drive CCH path query was prepared")
            .path(&metric, source, target)
    }
}

struct InMemoryDriveCch {
    structure: cch::Cch,
    time_metric: cch::Metric,
    distance_metric: cch::Metric,
    traffic_metric: Option<cch::Metric>,
    traffic_active: bool,
}

enum DriveCch {
    InMemory(Box<InMemoryDriveCch>),
    Persisted(Box<PersistedDriveCch>),
}

impl DriveCch {
    fn path(&mut self, minimize_distance: bool, source: u32, target: u32) -> Option<Vec<u32>> {
        match self {
            Self::InMemory(index) => {
                let metric = if minimize_distance {
                    index.distance_metric.view()
                } else if index.traffic_active {
                    index
                        .traffic_metric
                        .as_ref()
                        .expect("active drive traffic metric was customized")
                        .view()
                } else {
                    index.time_metric.view()
                };
                cch::node_path(&index.structure.view(), &metric, source, target)
            }
            Self::Persisted(index) => index.path(minimize_distance, source, target),
        }
    }

    fn time_distances(&self, sources: &[u32], targets: &[u32]) -> Vec<u32> {
        match self {
            Self::InMemory(index) => cch::distance_matrix(
                &index.structure.view(),
                &if index.traffic_active {
                    index
                        .traffic_metric
                        .as_ref()
                        .expect("active drive traffic metric was customized")
                        .view()
                } else {
                    index.time_metric.view()
                },
                sources,
                targets,
            ),
            Self::Persisted(index) => cch::distance_matrix(
                &index.structure.view(),
                &if index.traffic_active {
                    index
                        .traffic_metric
                        .as_ref()
                        .expect("active drive traffic metric was customized")
                        .view()
                } else {
                    index.time_metric.view()
                },
                sources,
                targets,
            ),
        }
    }

    fn traffic_active(&self) -> bool {
        match self {
            Self::InMemory(index) => index.traffic_active,
            Self::Persisted(index) => index.traffic_active,
        }
    }

    fn set_traffic_active(&mut self, active: bool) {
        match self {
            Self::InMemory(index) => index.traffic_active = active,
            Self::Persisted(index) => index.traffic_active = active,
        }
    }

    fn customize_traffic_time(&mut self, weights: &[u32]) -> napi::Result<()> {
        match self {
            Self::InMemory(index) => {
                if index.structure.input_arc_to_cch_arc.len() != weights.len() {
                    return Err(Error::from_reason(
                        "Drive CCH traffic metric does not match the resident input graph.",
                    ));
                }
                if let Some(metric) = &mut index.traffic_metric {
                    index.structure.customizer().customize_into(weights, metric);
                } else {
                    index.traffic_metric = Some(index.structure.customize(weights));
                }
                index.traffic_active = true;
            }
            Self::Persisted(index) => {
                if index.customization_structure.is_none() {
                    index.customization_structure = Some(
                        cch::Cch::load_struct(&index.structure_path).map_err(|error| {
                            Error::from_reason(format!(
                                "Unable to load the Drive CCH customization structure: {error}",
                            ))
                        })?,
                    );
                }
                let structure = index
                    .customization_structure
                    .as_ref()
                    .expect("drive customization structure was just loaded");
                if structure.input_arc_to_cch_arc.len() != weights.len() {
                    return Err(Error::from_reason(
                        "Persisted Drive CCH traffic metric does not match the resident input graph.",
                    ));
                }
                if let Some(metric) = &mut index.traffic_metric {
                    structure.customizer().customize_into(weights, metric);
                } else {
                    index.traffic_metric = Some(structure.customize(weights));
                }
                index.traffic_active = true;
            }
        }
        Ok(())
    }

    fn source(&self) -> &str {
        match self {
            Self::InMemory(_) => "in_memory",
            Self::Persisted(index) => &index.source,
        }
    }
}

fn open_drive_cch(
    structure_path: &Path,
    time_metric_path: &Path,
    distance_metric_path: &Path,
    node_count: usize,
    source: &str,
) -> napi::Result<DriveCch> {
    let structure = cch::CchBundle::open(structure_path).map_err(|error| {
        Error::from_reason(format!("Unable to mmap Drive CCH structure: {error}"))
    })?;
    let time_metric = cch::MetricBundle::open(time_metric_path).map_err(|error| {
        Error::from_reason(format!("Unable to mmap Drive time metric: {error}"))
    })?;
    let distance_metric = cch::MetricBundle::open(distance_metric_path).map_err(|error| {
        Error::from_reason(format!("Unable to mmap Drive distance metric: {error}"))
    })?;
    let structure_view = structure.view();
    let cch_arc_count = structure_view.cch_arc_count() as usize;
    if structure_view.node_count() as usize != node_count
        || time_metric.view().forward.len() != cch_arc_count
        || time_metric.view().backward.len() != cch_arc_count
        || distance_metric.view().forward.len() != cch_arc_count
        || distance_metric.view().backward.len() != cch_arc_count
    {
        return Err(Error::from_reason(
            "Drive CCH artifacts do not match the resident drive graph.",
        ));
    }
    Ok(DriveCch::Persisted(Box::new(PersistedDriveCch {
        path_query: None,
        path_view: None,
        structure,
        time_metric,
        distance_metric,
        structure_path: structure_path.to_path_buf(),
        customization_structure: None,
        traffic_metric: None,
        traffic_active: false,
        source: source.to_owned(),
    })))
}

#[allow(clippy::too_many_arguments)]
fn initialize_drive_cch(
    node_count: usize,
    node_lats: &[f64],
    node_lons: &[f64],
    edge_offsets: &[u32],
    edge_targets: &[u32],
    time_weights: &[u32],
    distance_weights: &[u32],
    structure_path: Option<String>,
    time_metric_path: Option<String>,
    distance_metric_path: Option<String>,
) -> napi::Result<DriveCch> {
    let persisted_paths = match (structure_path, time_metric_path, distance_metric_path) {
        (None, None, None) => None,
        (Some(structure), Some(time), Some(distance)) => Some((
            PathBuf::from(structure),
            PathBuf::from(time),
            PathBuf::from(distance),
        )),
        _ => {
            return Err(Error::from_reason(
                "Drive CCH requires all three immutable artifact paths or none.",
            ));
        }
    };
    if let Some((structure, time, distance)) = &persisted_paths {
        let exists = [structure.exists(), time.exists(), distance.exists()];
        if exists.iter().any(|value| *value) && !exists.iter().all(|value| *value) {
            return Err(Error::from_reason(
                "Drive CCH artifacts are incomplete; rebuild the structure and both metrics together.",
            ));
        }
        if exists.iter().all(|value| *value) {
            return open_drive_cch(structure, time, distance, node_count, "existing_mmap");
        }
    }

    let graph = cch::graph::Graph {
        first_out: edge_offsets.to_vec(),
        head: edge_targets.to_vec(),
        weight: time_weights.to_vec(),
    };
    let mut tails = Vec::with_capacity(edge_targets.len());
    for node in 0..node_count {
        tails.extend(std::iter::repeat_n(
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
    let order = cch::inertial_order(
        node_count as u32,
        &tails,
        edge_targets,
        &latitudes,
        &longitudes,
    );
    let structure = cch::Cch::build(&graph, &order);
    let customizer = structure.customizer();
    let time_metric = customizer.customize(time_weights);
    let distance_metric = customizer.customize(distance_weights);

    let Some((structure_path, time_path, distance_path)) = persisted_paths else {
        return Ok(DriveCch::InMemory(Box::new(InMemoryDriveCch {
            structure,
            time_metric,
            distance_metric,
            traffic_metric: None,
            traffic_active: false,
        })));
    };
    let temporary_structure = temporary_drive_cch_path(&structure_path);
    let temporary_time = temporary_drive_cch_path(&time_path);
    let temporary_distance = temporary_drive_cch_path(&distance_path);
    let persistence = (|| -> std::result::Result<(), String> {
        structure
            .save_struct(&temporary_structure)
            .map_err(|error| error.to_string())?;
        time_metric
            .save(&temporary_time)
            .map_err(|error| error.to_string())?;
        distance_metric
            .save(&temporary_distance)
            .map_err(|error| error.to_string())?;
        fs::rename(&temporary_structure, &structure_path).map_err(|error| error.to_string())?;
        fs::rename(&temporary_time, &time_path).map_err(|error| error.to_string())?;
        fs::rename(&temporary_distance, &distance_path).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = persistence {
        for path in [
            &temporary_structure,
            &temporary_time,
            &temporary_distance,
            &structure_path,
            &time_path,
            &distance_path,
        ] {
            let _ = fs::remove_file(path);
        }
        return Err(Error::from_reason(format!(
            "Unable to persist the Drive CCH artifacts atomically: {error}",
        )));
    }
    open_drive_cch(
        &structure_path,
        &time_path,
        &distance_path,
        node_count,
        "built_mmap",
    )
}

#[napi(object)]
pub struct DriveKernelInput {
    pub node_count: u32,
    pub node_lats: Float64Array,
    pub node_lons: Float64Array,
    pub edge_offsets: Uint32Array,
    pub edge_targets: Uint32Array,
    pub edge_distances: Option<Float64Array>,
    pub edge_travel_times: Option<Float64Array>,
    pub edge_distance_units: Option<Uint32Array>,
    pub edge_time_units: Option<Uint32Array>,
    pub cch_structure_path: Option<String>,
    pub cch_time_metric_path: Option<String>,
    pub cch_distance_metric_path: Option<String>,
}

#[napi(object)]
pub struct DriveTrafficInput {
    pub snapshot_key: String,
    pub edge_indices: Vec<u32>,
    pub edge_time_units: Vec<u32>,
}

#[napi(object)]
pub struct DriveQueryInput {
    pub origin_nodes: Vec<u32>,
    pub origin_snap_meters: Vec<f64>,
    pub target_nodes: Vec<u32>,
    pub target_snap_meters: Vec<f64>,
    pub maximum_distance_meters: f64,
    pub traffic: Option<DriveTrafficInput>,
}

#[napi(object)]
pub struct DriveQueryResult {
    pub supported: bool,
    pub status: String,
    pub reason: Option<String>,
    pub distance_meters: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub origin_snap_meters: Option<f64>,
    pub target_snap_meters: Option<f64>,
    pub node_indices: Vec<u32>,
    pub settled_labels: u32,
    pub relaxed_edges: u32,
    pub generated_labels: u32,
    pub dominated_labels: u32,
    pub fast_path_query_ns: f64,
    pub distance_path_query_ns: f64,
    pub fallback_query_ns: f64,
    pub fallback_used: bool,
    pub cch_accelerated: bool,
    pub cch_candidate_queries: u32,
    pub cch_source: String,
    pub traffic_applied: bool,
    pub traffic_snapshot_key: Option<String>,
    pub traffic_updated_edges: u32,
    pub traffic_customization_ns: f64,
    pub traffic_metric_reused: bool,
    pub query_ns: f64,
    pub algorithm: String,
}

#[napi(object)]
pub struct DriveMatrixInput {
    pub origin_offsets: Vec<u32>,
    pub origin_nodes: Vec<u32>,
    pub origin_snap_meters: Vec<f64>,
    pub target_offsets: Vec<u32>,
    pub target_nodes: Vec<u32>,
    pub target_snap_meters: Vec<f64>,
    pub maximum_distance_meters: f64,
    pub traffic: Option<DriveTrafficInput>,
}

#[napi(object)]
pub struct DriveMatrixResult {
    pub distances_m: Vec<f64>,
    pub durations_s: Vec<f64>,
    pub ready_pairs: u32,
    pub cch_candidate_queries: u32,
    pub path_queries: u32,
    pub query_ns: f64,
    pub cch_accelerated: bool,
    pub traffic_applied: bool,
    pub traffic_snapshot_key: Option<String>,
    pub traffic_updated_edges: u32,
    pub traffic_customization_ns: f64,
    pub traffic_metric_reused: bool,
    pub algorithm: String,
}

#[derive(Default)]
struct DriveTrafficQuery {
    applied: bool,
    snapshot_key: Option<String>,
    updated_edges: u32,
    customization_ns: f64,
    metric_reused: bool,
}

#[derive(Clone, Copy)]
struct DriveLabel {
    node: u32,
    time: f64,
    distance: f64,
    predecessor: i32,
    next_at_node: i32,
    active: bool,
}

struct CchDrivePath {
    distance_units: f64,
    time_units: f64,
    origin_snap_units: f64,
    target_snap_units: f64,
    nodes: Vec<u32>,
}

#[derive(Clone, Copy)]
struct DriveMatrixCandidate {
    node: u32,
    source_index: usize,
    snap_distance_units: f64,
    snap_time_units: f64,
}

#[napi(object)]
pub struct DriveKernelDiagnostics {
    pub node_count: u32,
    pub edge_count: u32,
    pub cch_accelerated: bool,
    pub cch_source: String,
    pub time_units_per_second: f64,
    pub distance_units_per_meter: f64,
}

#[allow(clippy::too_many_arguments)]
fn blocked_drive_result(
    started: &Instant,
    reason: &str,
    settled_labels: u32,
    relaxed_edges: u32,
    generated_labels: u32,
    dominated_labels: u32,
    fast_path_query_ns: f64,
    distance_path_query_ns: f64,
    fallback_query_ns: f64,
    fallback_used: bool,
    cch_candidate_queries: u32,
    cch_source: &str,
    traffic: &DriveTrafficQuery,
    algorithm: &str,
) -> DriveQueryResult {
    DriveQueryResult {
        supported: true,
        status: "blocked".to_owned(),
        reason: Some(reason.to_owned()),
        distance_meters: None,
        duration_seconds: None,
        origin_snap_meters: None,
        target_snap_meters: None,
        node_indices: Vec::new(),
        settled_labels,
        relaxed_edges,
        generated_labels,
        dominated_labels,
        fast_path_query_ns,
        distance_path_query_ns,
        fallback_query_ns,
        fallback_used,
        cch_accelerated: true,
        cch_candidate_queries,
        cch_source: cch_source.to_owned(),
        traffic_applied: traffic.applied,
        traffic_snapshot_key: traffic.snapshot_key.clone(),
        traffic_updated_edges: traffic.updated_edges,
        traffic_customization_ns: traffic.customization_ns,
        traffic_metric_reused: traffic.metric_reused,
        query_ns: started.elapsed().as_nanos() as f64,
        algorithm: algorithm.to_owned(),
    }
}

#[napi]
pub struct DriveKernel {
    node_count: usize,
    edge_offsets: Vec<u32>,
    edge_targets: Vec<u32>,
    edge_distance_units: Vec<u32>,
    edge_time_units: Vec<u32>,
    traffic_edge_time_units: Vec<u32>,
    traffic_snapshot_key: Option<String>,
    traffic_updated_edges: u32,
    cch: DriveCch,
    node_head: Vec<i32>,
    node_generation: Vec<u32>,
    target_snap_distance_units: Vec<f64>,
    target_snap_time_units: Vec<f64>,
    target_generation: Vec<u32>,
    generation: u32,
    labels: Vec<DriveLabel>,
    queue: BinaryHeap<MinEntry>,
}

impl DriveKernel {
    fn release_fallback_workspace(&mut self) {
        if self.labels.capacity() > RETAINED_DRIVE_LABEL_CAPACITY {
            self.labels = Vec::with_capacity(65_536);
        } else {
            self.labels.clear();
        }
        if self.queue.capacity() > RETAINED_DRIVE_LABEL_CAPACITY {
            self.queue = BinaryHeap::with_capacity(65_536);
        } else {
            self.queue.clear();
        }
    }

    fn next_generation(&mut self) -> u32 {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.node_generation.fill(0);
            self.target_generation.fill(0);
            self.generation = 1;
        }
        self.release_fallback_workspace();
        self.generation
    }

    fn configure_traffic(
        &mut self,
        traffic: Option<&DriveTrafficInput>,
    ) -> napi::Result<DriveTrafficQuery> {
        let Some(traffic) = traffic else {
            self.cch.set_traffic_active(false);
            return Ok(DriveTrafficQuery::default());
        };
        let snapshot_key = traffic.snapshot_key.trim();
        if snapshot_key.is_empty()
            || snapshot_key.len() > 256
            || traffic.edge_indices.is_empty()
            || traffic.edge_indices.len() != traffic.edge_time_units.len()
            || traffic.edge_indices.len() > self.edge_time_units.len()
            || traffic
                .edge_indices
                .iter()
                .any(|edge| *edge as usize >= self.edge_time_units.len())
            || traffic
                .edge_time_units
                .iter()
                .any(|weight| *weight == 0 || *weight > cch::INF_WEIGHT)
        {
            return Err(Error::from_reason(
                "Rust drive traffic metric input is inconsistent.",
            ));
        }
        if self.traffic_snapshot_key.as_deref() == Some(snapshot_key) {
            self.cch.set_traffic_active(true);
            return Ok(DriveTrafficQuery {
                applied: true,
                snapshot_key: Some(snapshot_key.to_owned()),
                updated_edges: self.traffic_updated_edges,
                customization_ns: 0.0,
                metric_reused: true,
            });
        }

        self.traffic_edge_time_units
            .clone_from(&self.edge_time_units);
        let mut updated_edges = 0_u32;
        for (&edge, &weight) in traffic.edge_indices.iter().zip(&traffic.edge_time_units) {
            let edge = edge as usize;
            let adjusted = if weight == cch::INF_WEIGHT {
                cch::INF_WEIGHT
            } else {
                weight.max(self.edge_time_units[edge])
            };
            if self.traffic_edge_time_units[edge] != adjusted {
                self.traffic_edge_time_units[edge] = adjusted;
                updated_edges = updated_edges.saturating_add(1);
            }
        }
        if updated_edges == 0 {
            self.cch.set_traffic_active(false);
            self.traffic_snapshot_key = None;
            self.traffic_updated_edges = 0;
            return Ok(DriveTrafficQuery::default());
        }

        let customization_started = Instant::now();
        self.cch
            .customize_traffic_time(&self.traffic_edge_time_units)?;
        let customization_ns = customization_started.elapsed().as_nanos() as f64;
        self.traffic_snapshot_key = Some(snapshot_key.to_owned());
        self.traffic_updated_edges = updated_edges;
        Ok(DriveTrafficQuery {
            applied: true,
            snapshot_key: Some(snapshot_key.to_owned()),
            updated_edges,
            customization_ns,
            metric_reused: false,
        })
    }

    fn active_edge_time_units(&self) -> &[u32] {
        if self.cch.traffic_active() {
            &self.traffic_edge_time_units
        } else {
            &self.edge_time_units
        }
    }

    fn evaluate_cch_node_path(
        &self,
        nodes: &[u32],
        minimize_distance: bool,
    ) -> napi::Result<(f64, f64)> {
        if nodes.is_empty() || nodes.len() > self.node_count {
            return Err(Error::from_reason(
                "Drive CCH returned an invalid node witness.",
            ));
        }
        let mut time_units = 0.0;
        let mut distance_units = 0.0;
        for pair in nodes.windows(2) {
            let source = pair[0] as usize;
            let target = pair[1];
            let mut selected: Option<(u32, u32)> = None;
            for edge in self.edge_offsets[source] as usize..self.edge_offsets[source + 1] as usize {
                if self.edge_targets[edge] != target {
                    continue;
                }
                let candidate = (
                    self.active_edge_time_units()[edge],
                    self.edge_distance_units[edge],
                );
                let better = selected.is_none_or(|current| {
                    if minimize_distance {
                        candidate.1 < current.1
                            || (candidate.1 == current.1 && candidate.0 < current.0)
                    } else {
                        candidate.0 < current.0
                            || (candidate.0 == current.0 && candidate.1 < current.1)
                    }
                });
                if better {
                    selected = Some(candidate);
                }
            }
            let Some((edge_time, edge_distance)) = selected else {
                return Err(Error::from_reason(
                    "Drive CCH witness contains an edge absent from the resident graph.",
                ));
            };
            time_units += f64::from(edge_time);
            distance_units += f64::from(edge_distance);
        }
        Ok((time_units, distance_units))
    }

    fn cch_optimal_path(
        &mut self,
        input: &DriveQueryInput,
        maximum_distance_units: f64,
        minimize_distance: bool,
    ) -> napi::Result<(Option<CchDrivePath>, u32)> {
        let origins = input
            .origin_nodes
            .iter()
            .copied()
            .zip(input.origin_snap_meters.iter().copied())
            .map(|(node, snap)| {
                Ok((
                    node,
                    f64::from(drive_weight(
                        snap,
                        DRIVE_DISTANCE_UNITS_PER_METER,
                        "Drive origin snap distance",
                    )?),
                    f64::from(drive_weight(
                        snap / DRIVE_SNAP_SPEED_MPS,
                        DRIVE_TIME_UNITS_PER_SECOND,
                        "Drive origin snap time",
                    )?),
                ))
            })
            .collect::<napi::Result<Vec<_>>>()?;
        let targets = input
            .target_nodes
            .iter()
            .copied()
            .zip(input.target_snap_meters.iter().copied())
            .map(|(node, snap)| {
                Ok((
                    node,
                    f64::from(drive_weight(
                        snap,
                        DRIVE_DISTANCE_UNITS_PER_METER,
                        "Drive target snap distance",
                    )?),
                    f64::from(drive_weight(
                        snap / DRIVE_SNAP_SPEED_MPS,
                        DRIVE_TIME_UNITS_PER_SECOND,
                        "Drive target snap time",
                    )?),
                ))
            })
            .collect::<napi::Result<Vec<_>>>()?;
        let mut best: Option<CchDrivePath> = None;
        let mut candidate_queries = 0_u32;
        for &(origin, origin_distance, origin_time) in &origins {
            if origin_distance > maximum_distance_units {
                continue;
            }
            for &(target, target_distance, target_time) in &targets {
                if origin_distance + target_distance > maximum_distance_units {
                    continue;
                }
                candidate_queries = candidate_queries.saturating_add(1);
                let Some(nodes) = self.cch.path(minimize_distance, origin, target) else {
                    continue;
                };
                let (path_time, path_distance) =
                    self.evaluate_cch_node_path(&nodes, minimize_distance)?;
                let candidate = CchDrivePath {
                    distance_units: origin_distance + path_distance + target_distance,
                    time_units: origin_time + path_time + target_time,
                    origin_snap_units: origin_distance,
                    target_snap_units: target_distance,
                    nodes,
                };
                let better = best.as_ref().is_none_or(|current| {
                    if minimize_distance {
                        drive_value_better(
                            candidate.distance_units,
                            candidate.time_units,
                            current.distance_units,
                            current.time_units,
                        )
                    } else {
                        drive_value_better(
                            candidate.time_units,
                            candidate.distance_units,
                            current.time_units,
                            current.distance_units,
                        )
                    }
                });
                if better {
                    best = Some(candidate);
                }
            }
        }
        Ok((best, candidate_queries))
    }

    fn offer_label(
        &mut self,
        generation: u32,
        node: usize,
        time: f64,
        distance: f64,
        predecessor: i32,
        dominated_labels: &mut u32,
    ) -> napi::Result<Option<u32>> {
        let mut head = if self.node_generation[node] == generation {
            self.node_head[node]
        } else {
            NO_INDEX
        };
        let mut cursor = head;
        while cursor >= 0 {
            let existing = self.labels[cursor as usize];
            if existing.active
                && existing.time <= time + EPSILON
                && existing.distance <= distance + EPSILON
            {
                *dominated_labels = dominated_labels.saturating_add(1);
                return Ok(None);
            }
            cursor = existing.next_at_node;
        }
        cursor = head;
        while cursor >= 0 {
            let existing = &mut self.labels[cursor as usize];
            if existing.active
                && time <= existing.time + EPSILON
                && distance <= existing.distance + EPSILON
            {
                existing.active = false;
                *dominated_labels = dominated_labels.saturating_add(1);
            }
            cursor = existing.next_at_node;
        }
        if self.labels.len() >= MAX_DRIVE_LABELS {
            return Err(Error::from_reason(
                "Exact constrained drive search exceeded its native label budget.",
            ));
        }
        if self.node_generation[node] != generation {
            self.node_generation[node] = generation;
            self.node_head[node] = NO_INDEX;
            head = NO_INDEX;
        }
        let index = self.labels.len() as u32;
        self.labels.push(DriveLabel {
            node: node as u32,
            time,
            distance,
            predecessor,
            next_at_node: head,
            active: true,
        });
        self.node_head[node] = index as i32;
        self.queue.push(MinEntry {
            key: time,
            item: index,
        });
        Ok(Some(index))
    }
}

#[napi]
impl DriveKernel {
    #[napi(constructor)]
    pub fn new(input: DriveKernelInput) -> napi::Result<Self> {
        let node_count = input.node_count as usize;
        let edge_count = input.edge_targets.len();
        if node_count == 0
            || input.node_lats.len() != node_count
            || input.node_lons.len() != node_count
            || input
                .node_lats
                .iter()
                .chain(input.node_lons.iter())
                .any(|value| !value.is_finite())
            || input.edge_offsets.len() != node_count + 1
            || input.edge_offsets[0] != 0
            || input.edge_offsets[node_count] as usize != edge_count
            || input
                .edge_targets
                .iter()
                .any(|target| *target as usize >= node_count)
            || input.edge_offsets.windows(2).any(|pair| pair[0] > pair[1])
        {
            return Err(Error::from_reason(
                "Rust drive kernel arrays are inconsistent.",
            ));
        }
        let edge_offsets = input.edge_offsets.to_vec();
        let edge_targets = input.edge_targets.to_vec();
        let (edge_distance_units, edge_time_units) = match (
            input.edge_distance_units.as_ref(),
            input.edge_time_units.as_ref(),
            input.edge_distances.as_ref(),
            input.edge_travel_times.as_ref(),
        ) {
            (Some(distances), Some(times), None, None)
                if distances.len() == edge_count && times.len() == edge_count =>
            {
                (distances.to_vec(), times.to_vec())
            }
            (None, None, Some(distances), Some(times))
                if distances.len() == edge_count && times.len() == edge_count =>
            {
                if distances
                    .iter()
                    .chain(times.iter())
                    .any(|value| !value.is_finite() || *value < 0.0)
                {
                    return Err(Error::from_reason(
                        "Rust drive kernel edge weights are invalid.",
                    ));
                }
                let distance_units = distances
                    .iter()
                    .map(|value| {
                        drive_weight(
                            *value,
                            DRIVE_DISTANCE_UNITS_PER_METER,
                            "Drive edge distance",
                        )
                    })
                    .collect::<napi::Result<Vec<_>>>()?;
                let time_units = times
                    .iter()
                    .map(|value| {
                        drive_weight(
                            *value,
                            DRIVE_TIME_UNITS_PER_SECOND,
                            "Drive edge travel time",
                        )
                    })
                    .collect::<napi::Result<Vec<_>>>()?;
                (distance_units, time_units)
            }
            _ => {
                return Err(Error::from_reason(
                    "Rust drive kernel requires one complete edge-weight representation.",
                ));
            }
        };
        let cch = initialize_drive_cch(
            node_count,
            &input.node_lats,
            &input.node_lons,
            &edge_offsets,
            &edge_targets,
            &edge_time_units,
            &edge_distance_units,
            input.cch_structure_path,
            input.cch_time_metric_path,
            input.cch_distance_metric_path,
        )?;
        let traffic_edge_time_units = edge_time_units.clone();
        Ok(Self {
            node_count,
            edge_offsets,
            edge_targets,
            edge_distance_units,
            edge_time_units,
            traffic_edge_time_units,
            traffic_snapshot_key: None,
            traffic_updated_edges: 0,
            cch,
            node_head: vec![NO_INDEX; node_count],
            node_generation: vec![0; node_count],
            target_snap_distance_units: vec![f64::INFINITY; node_count],
            target_snap_time_units: vec![f64::INFINITY; node_count],
            target_generation: vec![0; node_count],
            generation: 0,
            labels: Vec::with_capacity(65_536),
            queue: BinaryHeap::with_capacity(65_536),
        })
    }

    #[napi]
    pub fn diagnostics(&self) -> DriveKernelDiagnostics {
        DriveKernelDiagnostics {
            node_count: self.node_count as u32,
            edge_count: self.edge_targets.len() as u32,
            cch_accelerated: true,
            cch_source: self.cch.source().to_owned(),
            time_units_per_second: DRIVE_TIME_UNITS_PER_SECOND,
            distance_units_per_meter: DRIVE_DISTANCE_UNITS_PER_METER,
        }
    }

    #[napi]
    pub fn route_exact(&mut self, input: DriveQueryInput) -> napi::Result<DriveQueryResult> {
        let started = Instant::now();
        if input.origin_nodes.len() != input.origin_snap_meters.len()
            || input.target_nodes.len() != input.target_snap_meters.len()
            || input
                .origin_nodes
                .iter()
                .chain(input.target_nodes.iter())
                .any(|node| *node as usize >= self.node_count)
            || input
                .origin_snap_meters
                .iter()
                .chain(input.target_snap_meters.iter())
                .any(|value| !value.is_finite() || *value < 0.0)
            || !input.maximum_distance_meters.is_finite()
            || input.maximum_distance_meters <= 0.0
        {
            return Err(Error::from_reason(
                "Rust drive query candidates or distance bound are inconsistent.",
            ));
        }
        let traffic = self.configure_traffic(input.traffic.as_ref())?;
        let maximum_distance_units = f64::from(drive_weight(
            input.maximum_distance_meters,
            DRIVE_DISTANCE_UNITS_PER_METER,
            "Drive maximum distance",
        )?);
        let cch_source = self.cch.source().to_owned();
        if input.origin_nodes.is_empty() || input.target_nodes.is_empty() {
            return Ok(DriveQueryResult {
                supported: false,
                status: "blocked".to_owned(),
                reason: Some("street_snap_failed".to_owned()),
                distance_meters: None,
                duration_seconds: None,
                origin_snap_meters: None,
                target_snap_meters: None,
                node_indices: Vec::new(),
                settled_labels: 0,
                relaxed_edges: 0,
                generated_labels: 0,
                dominated_labels: 0,
                fast_path_query_ns: 0.0,
                distance_path_query_ns: 0.0,
                fallback_query_ns: 0.0,
                fallback_used: false,
                cch_accelerated: true,
                cch_candidate_queries: 0,
                cch_source,
                traffic_applied: traffic.applied,
                traffic_snapshot_key: traffic.snapshot_key.clone(),
                traffic_updated_edges: traffic.updated_edges,
                traffic_customization_ns: traffic.customization_ns,
                traffic_metric_reused: traffic.metric_reused,
                query_ns: started.elapsed().as_nanos() as f64,
                algorithm: "rust_cch_drive_input_guard".to_owned(),
            });
        }

        let fast_path_started = Instant::now();
        let (fastest, time_candidate_queries) =
            self.cch_optimal_path(&input, maximum_distance_units, false)?;
        let fast_path_query_ns = fast_path_started.elapsed().as_nanos() as f64;
        let Some(fastest) = fastest else {
            return Ok(blocked_drive_result(
                &started,
                "no_path",
                0,
                0,
                0,
                0,
                fast_path_query_ns,
                0.0,
                0.0,
                false,
                time_candidate_queries,
                &cch_source,
                &traffic,
                "rust_cch_time_no_path",
            ));
        };
        if fastest.distance_units <= maximum_distance_units + EPSILON {
            return Ok(DriveQueryResult {
                supported: true,
                status: "ready".to_owned(),
                reason: None,
                distance_meters: Some(fastest.distance_units / DRIVE_DISTANCE_UNITS_PER_METER),
                duration_seconds: Some(fastest.time_units / DRIVE_TIME_UNITS_PER_SECOND),
                origin_snap_meters: Some(
                    fastest.origin_snap_units / DRIVE_DISTANCE_UNITS_PER_METER,
                ),
                target_snap_meters: Some(
                    fastest.target_snap_units / DRIVE_DISTANCE_UNITS_PER_METER,
                ),
                node_indices: fastest.nodes,
                settled_labels: 0,
                relaxed_edges: 0,
                generated_labels: 0,
                dominated_labels: 0,
                fast_path_query_ns,
                distance_path_query_ns: 0.0,
                fallback_query_ns: 0.0,
                fallback_used: false,
                cch_accelerated: true,
                cch_candidate_queries: time_candidate_queries,
                cch_source,
                traffic_applied: traffic.applied,
                traffic_snapshot_key: traffic.snapshot_key.clone(),
                traffic_updated_edges: traffic.updated_edges,
                traffic_customization_ns: traffic.customization_ns,
                traffic_metric_reused: traffic.metric_reused,
                query_ns: started.elapsed().as_nanos() as f64,
                algorithm: "rust_cch_time_distance_certified".to_owned(),
            });
        }

        let distance_path_started = Instant::now();
        let (shortest, distance_candidate_queries) =
            self.cch_optimal_path(&input, maximum_distance_units, true)?;
        let distance_path_query_ns = distance_path_started.elapsed().as_nanos() as f64;
        let cch_candidate_queries =
            time_candidate_queries.saturating_add(distance_candidate_queries);
        let Some(shortest) = shortest else {
            return Ok(blocked_drive_result(
                &started,
                "no_path",
                0,
                0,
                0,
                0,
                fast_path_query_ns,
                distance_path_query_ns,
                0.0,
                false,
                cch_candidate_queries,
                &cch_source,
                &traffic,
                "rust_cch_distance_no_path",
            ));
        };
        if shortest.distance_units > maximum_distance_units + EPSILON {
            return Ok(blocked_drive_result(
                &started,
                "no_path",
                0,
                0,
                0,
                0,
                fast_path_query_ns,
                distance_path_query_ns,
                0.0,
                false,
                cch_candidate_queries,
                &cch_source,
                &traffic,
                "rust_cch_distance_infeasible",
            ));
        }

        let generation = self.next_generation();
        let fallback_started = Instant::now();
        for (&node, &snap) in input.target_nodes.iter().zip(&input.target_snap_meters) {
            let snap_distance_units = f64::from(drive_weight(
                snap,
                DRIVE_DISTANCE_UNITS_PER_METER,
                "Drive target snap distance",
            )?);
            if snap_distance_units > maximum_distance_units + EPSILON {
                continue;
            }
            let snap_time_units = f64::from(drive_weight(
                snap / DRIVE_SNAP_SPEED_MPS,
                DRIVE_TIME_UNITS_PER_SECOND,
                "Drive target snap time",
            )?);
            let node = node as usize;
            if self.target_generation[node] != generation
                || drive_value_better(
                    snap_time_units,
                    snap_distance_units,
                    self.target_snap_time_units[node],
                    self.target_snap_distance_units[node],
                )
            {
                self.target_generation[node] = generation;
                self.target_snap_distance_units[node] = snap_distance_units;
                self.target_snap_time_units[node] = snap_time_units;
            }
        }
        let mut dominated_labels = 0_u32;
        let mut label_budget_exceeded = false;
        for (&node, &snap) in input.origin_nodes.iter().zip(&input.origin_snap_meters) {
            let snap_distance_units = f64::from(drive_weight(
                snap,
                DRIVE_DISTANCE_UNITS_PER_METER,
                "Drive origin snap distance",
            )?);
            if snap_distance_units > maximum_distance_units + EPSILON {
                continue;
            }
            let snap_time_units = f64::from(drive_weight(
                snap / DRIVE_SNAP_SPEED_MPS,
                DRIVE_TIME_UNITS_PER_SECOND,
                "Drive origin snap time",
            )?);
            if self
                .offer_label(
                    generation,
                    node as usize,
                    snap_time_units,
                    snap_distance_units,
                    NO_INDEX,
                    &mut dominated_labels,
                )
                .is_err()
            {
                label_budget_exceeded = true;
                break;
            }
        }

        let mut settled_labels = 0_u32;
        let mut relaxed_edges = 0_u32;
        let mut best_label = NO_INDEX;
        let mut best_time = f64::INFINITY;
        let mut best_distance = f64::INFINITY;
        let mut best_target_snap = 0.0;
        'fallback_search: while !label_budget_exceeded {
            let Some(entry) = self.queue.pop() else {
                break;
            };
            let label_index = entry.item as usize;
            let label = self.labels[label_index];
            if !label.active || entry.key.to_bits() != label.time.to_bits() {
                continue;
            }
            if label.time > best_time + EPSILON {
                break;
            }
            settled_labels = settled_labels.saturating_add(1);
            let node = label.node as usize;
            if self.target_generation[node] == generation {
                let target_snap_distance = self.target_snap_distance_units[node];
                let total_distance = label.distance + target_snap_distance;
                let total_time = label.time + self.target_snap_time_units[node];
                if total_distance <= maximum_distance_units + EPSILON
                    && (total_time < best_time - EPSILON
                        || ((total_time - best_time).abs() <= EPSILON
                            && total_distance < best_distance))
                {
                    best_label = label_index as i32;
                    best_time = total_time;
                    best_distance = total_distance;
                    best_target_snap = target_snap_distance;
                }
            }
            let start = self.edge_offsets[node] as usize;
            let end = self.edge_offsets[node + 1] as usize;
            for edge in start..end {
                relaxed_edges = relaxed_edges.saturating_add(1);
                let edge_time_units = self.active_edge_time_units()[edge];
                if edge_time_units == cch::INF_WEIGHT {
                    continue;
                }
                let distance = label.distance + f64::from(self.edge_distance_units[edge]);
                if distance > maximum_distance_units + EPSILON {
                    continue;
                }
                let time = label.time + f64::from(edge_time_units);
                if time > best_time + EPSILON {
                    continue;
                }
                if self
                    .offer_label(
                        generation,
                        self.edge_targets[edge] as usize,
                        time,
                        distance,
                        label_index as i32,
                        &mut dominated_labels,
                    )
                    .is_err()
                {
                    label_budget_exceeded = true;
                    break 'fallback_search;
                }
            }
        }

        let fallback_query_ns = fallback_started.elapsed().as_nanos() as f64;
        let generated_labels = self.labels.len() as u32;
        if label_budget_exceeded {
            self.release_fallback_workspace();
            return Ok(blocked_drive_result(
                &started,
                "exact_drive_label_budget_exceeded",
                settled_labels,
                relaxed_edges,
                generated_labels,
                dominated_labels,
                fast_path_query_ns,
                distance_path_query_ns,
                fallback_query_ns,
                true,
                cch_candidate_queries,
                &cch_source,
                &traffic,
                "rust_cch_candidate_exact_resource_constrained_fallback",
            ));
        }
        if best_label < 0 {
            self.release_fallback_workspace();
            return Ok(blocked_drive_result(
                &started,
                "no_path",
                settled_labels,
                relaxed_edges,
                generated_labels,
                dominated_labels,
                fast_path_query_ns,
                distance_path_query_ns,
                fallback_query_ns,
                true,
                cch_candidate_queries,
                &cch_source,
                &traffic,
                "rust_cch_candidate_exact_resource_constrained_fallback",
            ));
        }
        let mut node_indices = Vec::new();
        let mut cursor = best_label;
        while cursor >= 0 {
            let label = self.labels[cursor as usize];
            node_indices.push(label.node);
            cursor = label.predecessor;
        }
        node_indices.reverse();
        let mut root = best_label;
        while self.labels[root as usize].predecessor >= 0 {
            root = self.labels[root as usize].predecessor;
        }
        let origin_snap = self.labels[root as usize].distance;
        self.release_fallback_workspace();
        Ok(DriveQueryResult {
            supported: true,
            status: "ready".to_owned(),
            reason: None,
            distance_meters: Some(best_distance / DRIVE_DISTANCE_UNITS_PER_METER),
            duration_seconds: Some(best_time / DRIVE_TIME_UNITS_PER_SECOND),
            origin_snap_meters: Some(origin_snap / DRIVE_DISTANCE_UNITS_PER_METER),
            target_snap_meters: Some(best_target_snap / DRIVE_DISTANCE_UNITS_PER_METER),
            node_indices,
            settled_labels,
            relaxed_edges,
            generated_labels,
            dominated_labels,
            fast_path_query_ns,
            distance_path_query_ns,
            fallback_query_ns,
            fallback_used: true,
            cch_accelerated: true,
            cch_candidate_queries,
            cch_source,
            traffic_applied: traffic.applied,
            traffic_snapshot_key: traffic.snapshot_key,
            traffic_updated_edges: traffic.updated_edges,
            traffic_customization_ns: traffic.customization_ns,
            traffic_metric_reused: traffic.metric_reused,
            query_ns: started.elapsed().as_nanos() as f64,
            algorithm: "rust_cch_candidate_exact_resource_constrained_fallback".to_owned(),
        })
    }

    /// Compute a scalar coordinate-candidate matrix using one time-metric CCH
    /// matrix for all unique source and target snap nodes. Only the selected
    /// fastest witnesses are unpacked to keep distance and duration on the
    /// same path; cells that exceed the distance ceiling reuse the exact
    /// constrained fallback. Geometry is intentionally left to point replays.
    #[napi]
    pub fn route_matrix(&mut self, input: DriveMatrixInput) -> napi::Result<DriveMatrixResult> {
        let origin_count = input.origin_offsets.len().saturating_sub(1);
        let target_count = input.target_offsets.len().saturating_sub(1);
        let valid_offsets = |offsets: &[u32], values_len: usize| {
            offsets.len() >= 2
                && offsets.first().copied() == Some(0)
                && offsets
                    .last()
                    .copied()
                    .is_some_and(|offset| offset as usize == values_len)
                && offsets.windows(2).all(|pair| pair[0] <= pair[1])
        };
        if origin_count == 0
            || target_count == 0
            || origin_count > 256
            || target_count > 256
            || origin_count.saturating_mul(target_count) > 50_000
            || !valid_offsets(&input.origin_offsets, input.origin_nodes.len())
            || !valid_offsets(&input.target_offsets, input.target_nodes.len())
            || input.origin_nodes.len() != input.origin_snap_meters.len()
            || input.target_nodes.len() != input.target_snap_meters.len()
            || input
                .origin_nodes
                .iter()
                .chain(input.target_nodes.iter())
                .any(|node| *node as usize >= self.node_count)
            || input
                .origin_snap_meters
                .iter()
                .chain(input.target_snap_meters.iter())
                .any(|snap| !snap.is_finite() || *snap < 0.0)
            || !input.maximum_distance_meters.is_finite()
            || input.maximum_distance_meters <= 0.0
        {
            return Err(Error::from_reason(
                "Rust drive matrix candidate arrays or bounds are inconsistent.",
            ));
        }

        let started = Instant::now();
        let traffic = self.configure_traffic(input.traffic.as_ref())?;
        let maximum_distance_units = f64::from(drive_weight(
            input.maximum_distance_meters,
            DRIVE_DISTANCE_UNITS_PER_METER,
            "Drive maximum distance",
        )?);

        let mut source_nodes = Vec::new();
        let mut target_nodes = Vec::new();
        let mut source_lookup = HashMap::<u32, usize>::new();
        let mut target_lookup = HashMap::<u32, usize>::new();
        let build_candidates = |offsets: &[u32],
                                nodes: &[u32],
                                snaps: &[f64],
                                unique_nodes: &mut Vec<u32>,
                                lookup: &mut HashMap<u32, usize>| {
            let mut groups = Vec::with_capacity(offsets.len().saturating_sub(1));
            for group in 0..offsets.len() - 1 {
                let start = offsets[group] as usize;
                let end = offsets[group + 1] as usize;
                let mut best_snap_by_node = HashMap::<u32, f64>::new();
                for index in start..end {
                    let node = nodes[index];
                    let snap = snaps[index];
                    let entry = best_snap_by_node.entry(node).or_insert(snap);
                    if snap < *entry {
                        *entry = snap;
                    }
                }
                let candidates = best_snap_by_node
                    .into_iter()
                    .map(|(node, snap_meters)| {
                        let source_index = *lookup.entry(node).or_insert_with(|| {
                            unique_nodes.push(node);
                            unique_nodes.len() - 1
                        });
                        Ok(DriveMatrixCandidate {
                            node,
                            source_index,
                            snap_distance_units: f64::from(drive_weight(
                                snap_meters,
                                DRIVE_DISTANCE_UNITS_PER_METER,
                                "Drive snap distance",
                            )?),
                            snap_time_units: f64::from(drive_weight(
                                snap_meters / DRIVE_SNAP_SPEED_MPS,
                                DRIVE_TIME_UNITS_PER_SECOND,
                                "Drive snap time",
                            )?),
                        })
                    })
                    .collect::<napi::Result<Vec<_>>>()?;
                groups.push(candidates);
            }
            Ok::<_, napi::Error>(groups)
        };
        let origin_candidates = build_candidates(
            &input.origin_offsets,
            &input.origin_nodes,
            &input.origin_snap_meters,
            &mut source_nodes,
            &mut source_lookup,
        )?;
        let target_candidates = build_candidates(
            &input.target_offsets,
            &input.target_nodes,
            &input.target_snap_meters,
            &mut target_nodes,
            &mut target_lookup,
        )?;

        let time_matrix = self.cch.time_distances(&source_nodes, &target_nodes);
        let mut distances_m = vec![f64::INFINITY; origin_count * target_count];
        let mut durations_s = vec![f64::INFINITY; origin_count * target_count];
        let mut ready_pairs = 0_u32;
        let mut path_queries = 0_u32;
        let mut cch_candidate_queries = source_nodes
            .len()
            .saturating_mul(target_nodes.len())
            .min(u32::MAX as usize) as u32;
        for (origin, origin_group) in origin_candidates.iter().enumerate() {
            for (target, target_group) in target_candidates.iter().enumerate() {
                let mut best_time_units = f64::INFINITY;
                for source in origin_group {
                    for destination in target_group {
                        if source.snap_distance_units + destination.snap_distance_units
                            > maximum_distance_units + EPSILON
                        {
                            continue;
                        }
                        let matrix_index =
                            source.source_index * target_nodes.len() + destination.source_index;
                        let graph_time = time_matrix[matrix_index];
                        if graph_time == cch::INF_WEIGHT {
                            continue;
                        }
                        let total_time = source.snap_time_units
                            + f64::from(graph_time)
                            + destination.snap_time_units;
                        if total_time < best_time_units - EPSILON {
                            best_time_units = total_time;
                        }
                    }
                }
                if !best_time_units.is_finite() {
                    continue;
                }

                let mut best_path: Option<(f64, f64)> = None;
                for source in origin_group {
                    for destination in target_group {
                        if source.snap_distance_units + destination.snap_distance_units
                            > maximum_distance_units + EPSILON
                        {
                            continue;
                        }
                        let matrix_index =
                            source.source_index * target_nodes.len() + destination.source_index;
                        let graph_time = time_matrix[matrix_index];
                        if graph_time == cch::INF_WEIGHT {
                            continue;
                        }
                        let total_time = source.snap_time_units
                            + f64::from(graph_time)
                            + destination.snap_time_units;
                        if (total_time - best_time_units).abs() > EPSILON {
                            continue;
                        }
                        cch_candidate_queries = cch_candidate_queries.saturating_add(1);
                        path_queries = path_queries.saturating_add(1);
                        let Some(nodes) = self.cch.path(false, source.node, destination.node)
                        else {
                            continue;
                        };
                        let (path_time, path_distance) =
                            self.evaluate_cch_node_path(&nodes, false)?;
                        let total_path_time =
                            source.snap_time_units + path_time + destination.snap_time_units;
                        let total_path_distance = source.snap_distance_units
                            + path_distance
                            + destination.snap_distance_units;
                        let better = best_path.is_none_or(|(current_time, current_distance)| {
                            drive_value_better(
                                total_path_time,
                                total_path_distance,
                                current_time,
                                current_distance,
                            )
                        });
                        if better {
                            best_path = Some((total_path_time, total_path_distance));
                        }
                    }
                }

                let output_index = origin * target_count + target;
                if let Some((best_path_time, best_path_distance)) =
                    best_path.filter(|(_, distance)| *distance <= maximum_distance_units + EPSILON)
                {
                    distances_m[output_index] = best_path_distance / DRIVE_DISTANCE_UNITS_PER_METER;
                    durations_s[output_index] = best_path_time / DRIVE_TIME_UNITS_PER_SECOND;
                    ready_pairs = ready_pairs.saturating_add(1);
                    continue;
                }
            }
        }

        Ok(DriveMatrixResult {
            distances_m,
            durations_s,
            ready_pairs,
            cch_candidate_queries,
            path_queries,
            query_ns: started.elapsed().as_nanos() as f64,
            cch_accelerated: true,
            traffic_applied: traffic.applied,
            traffic_snapshot_key: traffic.snapshot_key,
            traffic_updated_edges: traffic.updated_edges,
            traffic_customization_ns: traffic.customization_ns,
            traffic_metric_reused: traffic.metric_reused,
            algorithm: "rust_cch_drive_time_matrix_v1".to_owned(),
        })
    }
}
