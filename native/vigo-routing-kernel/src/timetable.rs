use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::time::Instant;

mod journeys;
pub use journeys::TimetableMatrixJourney;

const STATE_STRIDE: usize = 8;
const TRANSFER_BOARD_SLACK_SECONDS: f64 = 0.0;
const NO_STATE: i32 = -1;
const SCAN_CAN_BOARD: u8 = 1;
const SCAN_CAN_ALIGHT: u8 = 2;
const SCAN_BRIDGE_EXIT: u8 = 4;
const SCAN_RUN_MASK: u32 = (1 << 29) - 1;
const EXIT_TIME_MASK: u32 = (1 << 20) - 1;
const EXIT_RELATIVE_SEGMENT_MASK: u32 = (1 << 15) - 1;
const MAX_PARETO_LABELS: usize = 2_000_000;
const MAX_PROFILE_BOARDINGS: usize = 32;
const MAX_OVERLAY_STOPS: usize = 4_096;
const MAX_OVERLAY_CONNECTIONS: usize = 1_000_000;
type JourneyChainStep = (u32, i32, i32, i32, f64, f64, u32, f64);

#[derive(Clone, Copy)]
struct ScanEvent(u64);

impl ScanEvent {
    #[inline(always)]
    fn source_stop(self) -> usize {
        self.0 as u32 as usize
    }

    #[inline(always)]
    fn run(self) -> usize {
        ((self.0 >> 32) as u32 & SCAN_RUN_MASK) as usize
    }

    #[inline(always)]
    fn flags(self) -> u8 {
        ((self.0 >> 61) & 7) as u8
    }
}

#[derive(Clone, Copy)]
struct ScanArrival {
    arrival: u32,
    to: u32,
}

#[derive(Clone, Copy)]
struct ScanJourney {
    trip: u32,
    sequence: u32,
    prior_sequence: u32,
}

#[derive(Clone, Copy)]
struct TransferEdge(u64);

impl TransferEdge {
    fn new(stop: u32, duration: u32) -> Self {
        Self(u64::from(stop) | (u64::from(duration) << 32))
    }

    #[inline(always)]
    fn stop(self) -> usize {
        self.0 as u32 as usize
    }

    #[inline(always)]
    fn duration(self) -> u32 {
        (self.0 >> 32) as u32
    }
}

#[derive(Clone, Copy)]
struct DepartureEvent {
    departure: u32,
    run: u32,
}

#[derive(Clone, Copy)]
struct ExitEvent(u64);

impl ExitEvent {
    fn new(time: u32, run: u32, through_segment: u32, run_start: u32) -> Self {
        let relative_segment = through_segment - run_start;
        Self(u64::from(time) | (u64::from(run) << 20) | (u64::from(relative_segment) << 49))
    }

    #[inline(always)]
    fn time(self) -> u32 {
        self.0 as u32 & EXIT_TIME_MASK
    }

    #[inline(always)]
    fn run(self) -> usize {
        ((self.0 >> 20) as u32 & SCAN_RUN_MASK) as usize
    }

    #[inline(always)]
    fn through_segment(self, run_start: &[u32]) -> u32 {
        run_start[self.run()] + ((self.0 >> 49) as u32 & EXIT_RELATIVE_SEGMENT_MASK)
    }
}

#[napi(object)]
pub struct TimetableKernelInput {
    pub stop_count: u32,
    pub run_count: u32,
    pub departure_seconds: Uint32Array,
    pub arrival_seconds: Uint32Array,
    pub from_stop: Uint32Array,
    pub to_stop: Uint32Array,
    pub sequence: Uint32Array,
    pub segment_trip: Uint32Array,
    pub segment_run: Uint32Array,
    pub continuity_break: Uint8Array,
    pub can_board: Uint8Array,
    pub can_alight: Uint8Array,
    pub trip_start: Uint32Array,
    pub departure_offset: Uint32Array,
    pub departure_order: Uint32Array,
    pub transfer_offset: Uint32Array,
    pub transfer_to: Uint32Array,
    pub transfer_duration: Uint32Array,
    pub forbidden_same_stop: Uint8Array,
    pub same_stop_transfer_minimum: Option<Uint32Array>,
}

#[derive(Clone)]
#[napi(object)]
pub struct TimetableQueryInput {
    pub origin_stops: Vec<u32>,
    pub origin_walk_seconds: Vec<f64>,
    pub origin_candidate_indices: Vec<u32>,
    pub destination_stops: Vec<u32>,
    pub destination_walk_seconds: Vec<f64>,
    pub destination_candidate_indices: Vec<u32>,
    pub departure: f64,
    pub horizon: f64,
    pub allow_pre_ride_transfers: bool,
    pub allow_post_ride_transfers: Option<bool>,
    pub maximum_boardings: Option<u32>,
}

#[napi(object)]
pub struct TimetableQueryResult {
    pub supported: bool,
    pub status: String,
    pub reason: Option<String>,
    pub best_arrival: Option<f64>,
    pub best_boardings: Option<u32>,
    pub best_destination_index: Option<u32>,
    pub chain_kinds: Vec<u32>,
    pub chain_from_stops: Vec<i32>,
    pub chain_to_stops: Vec<i32>,
    pub chain_trip_or_candidate: Vec<i32>,
    pub chain_board_sequences: Vec<f64>,
    pub chain_alight_sequences: Vec<f64>,
    pub chain_durations: Vec<u32>,
    pub chain_arrivals: Vec<f64>,
    pub query_ns: f64,
    pub destination_seed_ns: f64,
    pub origin_seed_ns: f64,
    pub scan_ns: f64,
    pub chain_ns: f64,
    pub popped_states: u32,
    pub scanned_departures: u32,
    pub relaxed_stops: u32,
    pub expanded_trip_runs: u32,
    pub dominated_trip_boardings: u32,
    pub explicit_transfer_checks: u32,
}

#[napi(object)]
pub struct TimetableArriveByQueryInput {
    pub origin_stops: Vec<u32>,
    pub origin_walk_seconds: Vec<f64>,
    pub origin_candidate_indices: Vec<u32>,
    pub destination_stops: Vec<u32>,
    pub destination_walk_seconds: Vec<f64>,
    pub destination_candidate_indices: Vec<u32>,
    pub earliest: f64,
    pub deadline: f64,
    pub allow_pre_ride_transfers: bool,
    pub allow_post_ride_transfers: Option<bool>,
    pub maximum_boardings: Option<u32>,
}

#[napi(object)]
pub struct TimetableArriveByQueryResult {
    pub supported: bool,
    pub status: String,
    pub reason: Option<String>,
    pub latest_departure: Option<f64>,
    pub candidate_count: u32,
    pub verified_candidates: u32,
    pub query_ns: f64,
    pub engine_query_ns: f64,
    pub scanned_departures: u32,
    pub relaxed_stops: u32,
    pub expanded_trip_runs: u32,
    pub dominated_trip_boardings: u32,
    pub explicit_transfer_checks: u32,
}

#[napi(object)]
pub struct TimetableManyQueryInput {
    pub origin_stops: Vec<u32>,
    pub origin_walk_seconds: Vec<f64>,
    pub destination_offsets: Vec<u32>,
    pub destination_stops: Vec<u32>,
    pub destination_walk_seconds: Vec<f64>,
    pub excluded_trips: Vec<u32>,
    pub departure: f64,
    pub horizon: f64,
    pub allow_pre_ride_transfers: bool,
    pub allow_post_ride_transfers: Option<Vec<bool>>,
    pub maximum_boardings: Option<u32>,
}

#[napi(object)]
pub struct TimetableArriveByManyQueryInput {
    pub origin_offsets: Vec<u32>,
    pub origin_stops: Vec<u32>,
    pub origin_walk_seconds: Vec<f64>,
    pub allow_pre_ride_transfers: Vec<bool>,
    pub destination_stops: Vec<u32>,
    pub destination_walk_seconds: Vec<f64>,
    pub earliest: f64,
    pub deadline: f64,
    pub excluded_trips: Vec<u32>,
    pub allow_post_ride_transfers: Option<bool>,
    pub maximum_boardings: Option<u32>,
}

#[napi(object)]
pub struct TimetableArriveByManyQueryResult {
    pub latest_departures: Vec<f64>,
    pub query_ns: f64,
    pub scanned_departures: u32,
    pub excluded_departures: u32,
    pub relaxed_stops: u32,
    pub expanded_trip_runs: u32,
    pub dominated_trip_boardings: u32,
    pub explicit_transfer_checks: u32,
}

#[napi(object)]
pub struct TimetableMatrixQueryInput {
    pub origin_offsets: Vec<u32>,
    pub origin_stops: Vec<u32>,
    pub origin_walk_seconds: Vec<f64>,
    pub allow_pre_ride_transfers: Vec<bool>,
    pub destination_offsets: Vec<u32>,
    pub destination_stops: Vec<u32>,
    pub destination_walk_seconds: Vec<f64>,
    pub departure: f64,
    pub horizon: f64,
    pub arrive_by: bool,
    pub allow_post_ride_transfers: Option<Vec<bool>>,
    pub maximum_boardings: Option<u32>,
    pub include_journeys: Option<bool>,
}

#[napi(object)]
pub struct TimetableMatrixQueryResult {
    pub times: Vec<f64>,
    pub journeys: Option<Vec<Option<TimetableMatrixJourney>>>,
    pub forward_searches: u32,
    pub reverse_searches: u32,
    pub query_ns: f64,
    pub scanned_departures: f64,
    pub relaxed_stops: f64,
    pub expanded_trip_runs: f64,
    pub dominated_trip_boardings: f64,
    pub explicit_transfer_checks: f64,
}

#[napi(object)]
pub struct TimetableManyQueryResult {
    pub supported: bool,
    pub status: String,
    pub reason: Option<String>,
    pub algorithm: String,
    pub best_arrivals: Vec<f64>,
    pub best_destination_index: Option<u32>,
    pub chain_kinds: Vec<u32>,
    pub chain_from_stops: Vec<i32>,
    pub chain_to_stops: Vec<i32>,
    pub chain_trip_or_candidate: Vec<i32>,
    pub chain_board_sequences: Vec<f64>,
    pub chain_alight_sequences: Vec<f64>,
    pub chain_durations: Vec<u32>,
    pub chain_arrivals: Vec<f64>,
    pub query_ns: f64,
    pub scanned_departures: u32,
    pub excluded_departures: u32,
    pub relaxed_stops: u32,
    pub expanded_trip_runs: u32,
    pub dominated_trip_boardings: u32,
    pub explicit_transfer_checks: u32,
}

/// Query-scoped service overlay compiled into the resident chronological scan.
/// Overlay stops are local indices in `0..overlay_stop_count`; the native
/// kernel maps them immediately after the resident stop domain. Supplemental
/// transfers use that combined resident+overlay stop domain.
#[napi(object)]
pub struct TimetableOverlayManyQueryInput {
    pub origin_stops: Vec<u32>,
    pub origin_walk_seconds: Vec<f64>,
    pub destination_offsets: Vec<u32>,
    pub destination_stops: Vec<u32>,
    pub destination_walk_seconds: Vec<f64>,
    pub excluded_trips: Vec<u32>,
    pub departure: f64,
    pub horizon: f64,
    pub allow_pre_ride_transfers: bool,
    pub overlay_stop_count: u32,
    pub direction_offsets: Vec<u32>,
    pub direction_stops: Vec<u32>,
    pub direction_stop_offsets_seconds: Vec<f64>,
    pub service_start_seconds: Vec<f64>,
    pub service_end_seconds: Vec<f64>,
    pub service_headway_seconds: Vec<f64>,
    pub supplemental_transfer_offsets: Vec<u32>,
    pub supplemental_transfer_to: Vec<u32>,
    pub supplemental_transfer_duration: Vec<u32>,
    pub origin_candidate_indices: Option<Vec<u32>>,
    pub destination_candidate_indices: Option<Vec<u32>>,
    pub direction_can_board: Option<Vec<u8>>,
    pub direction_can_alight: Option<Vec<u8>>,
    pub allow_post_ride_transfers: Option<Vec<bool>>,
    pub maximum_boardings: Option<u32>,
}

#[napi(object)]
pub struct TimetableOverlayManyQueryResult {
    pub timetable: TimetableManyQueryResult,
    pub overlay_connections: u32,
    pub overlay_runs: u32,
    pub supplemental_transfer_edges: u32,
    pub compile_ns: f64,
    pub scan_ns: f64,
    pub transient_bytes: f64,
    pub workspace_bytes: f64,
}

#[napi(object)]
pub struct TimetableParetoQueryInput {
    pub origin_stops: Vec<u32>,
    pub origin_walk_seconds: Vec<f64>,
    pub origin_candidate_indices: Vec<u32>,
    pub destination_stops: Vec<u32>,
    pub destination_walk_seconds: Vec<f64>,
    pub destination_candidate_indices: Vec<u32>,
    pub departure: f64,
    pub horizon: f64,
    pub allow_pre_ride_transfers: bool,
    pub earliest_arrival: f64,
    pub boarding_upper_bound: u32,
    pub candidate_destination_index: u32,
    pub candidate_walking_seconds: f64,
    pub arrival_slack_seconds: f64,
    pub transfer_penalty_seconds: f64,
    pub walk_reluctance: f64,
    /// Return arrival/boarding/walking trade-offs inside the supplied bounds.
    pub collect_alternatives: Option<bool>,
    /// Optional exact corridor restriction mode used by the production Pareto certifier.
    pub restriction_mode: Option<String>,
    pub allow_post_ride_transfers: Option<bool>,
    /// At a fixed latest departure, minimize boardings, then walking, then
    /// arrival, subject to the supplied hard arrival bound.
    pub deadline_objective: Option<bool>,
}

#[napi(object)]
pub struct TimetableParetoQueryResult {
    pub supported: bool,
    pub status: String,
    pub reason: Option<String>,
    pub best_arrival: Option<f64>,
    pub best_boardings: Option<u32>,
    pub best_destination_index: Option<u32>,
    pub best_walking_seconds: Option<f64>,
    pub best_generalized_seconds: Option<f64>,
    pub improved_candidate: bool,
    pub alternatives: Option<Vec<TimetableParetoAlternative>>,
    pub chain_kinds: Vec<u32>,
    pub chain_from_stops: Vec<i32>,
    pub chain_to_stops: Vec<i32>,
    pub chain_trip_or_candidate: Vec<i32>,
    pub chain_board_sequences: Vec<f64>,
    pub chain_alight_sequences: Vec<f64>,
    pub chain_durations: Vec<u32>,
    pub chain_arrivals: Vec<f64>,
    pub query_ns: f64,
    pub corridor_ns: f64,
    pub forward_ns: f64,
    pub reverse_ns: f64,
    pub round_ns: f64,
    pub corridor_exit_events: f64,
    pub corridor_run_segments: f64,
    pub corridor_transfer_edges: f64,
    pub forward_departure_events: f64,
    pub forward_run_segments: f64,
    pub forward_transfer_edges: f64,
    pub scanned_departures: u32,
    pub relaxed_stops: u32,
    pub expanded_trip_runs: u32,
    pub dominated_trip_boardings: u32,
    pub explicit_transfer_checks: u32,
    pub dominated_candidate_labels: u32,
    pub dominated_existing_labels: u32,
    pub terminal_candidates_evaluated: u32,
    pub pareto_labels: u32,
    pub run_profiles: u32,
    pub restriction_mode: String,
    pub forward_restriction_applied: bool,
    pub reverse_restriction_applied: bool,
    pub scalar_envelope_reused: bool,
    pub forward_envelope_built: bool,
    pub reverse_corridor_built: bool,
    pub retained_run_layer_memberships: f64,
    pub total_run_layer_memberships: f64,
    pub retained_segment_layer_memberships: f64,
    pub total_segment_layer_memberships: f64,
    pub retained_stop_deadline_memberships: f64,
    pub total_stop_deadline_memberships: f64,
    pub retained_unique_runs: u32,
    pub restriction_bytes: f64,
    pub label_bytes: f64,
}

#[napi(object)]
pub struct TimetableParetoAlternative {
    pub best_arrival: f64,
    pub best_boardings: u32,
    pub best_destination_index: u32,
    pub best_walking_seconds: f64,
    pub chain_kinds: Vec<u32>,
    pub chain_from_stops: Vec<i32>,
    pub chain_to_stops: Vec<i32>,
    pub chain_trip_or_candidate: Vec<i32>,
    pub chain_board_sequences: Vec<f64>,
    pub chain_alight_sequences: Vec<f64>,
    pub chain_durations: Vec<u32>,
    pub chain_arrivals: Vec<f64>,
}

#[napi(object)]
pub struct TimetableKernelDiagnostics {
    pub stop_count: u32,
    pub state_count: u32,
    pub segment_count: u32,
    pub trip_count: u32,
    pub run_count: u32,
    pub transfer_count: u32,
    pub transfer_board_slack_seconds: f64,
    pub workspace_bytes: f64,
    pub source_array_bytes: f64,
    pub native_index_bytes: f64,
    pub array_bytes: f64,
    pub zero_copy_arrays: bool,
    pub algorithm: String,
}

#[derive(Clone, Copy)]
struct ScalarLabel {
    arrival: f64,
    generation: u32,
    boardings: u16,
    walking_seconds: u16,
}

impl Default for ScalarLabel {
    fn default() -> Self {
        Self {
            arrival: f64::INFINITY,
            generation: 0,
            boardings: u16::MAX,
            walking_seconds: u16::MAX,
        }
    }
}

#[derive(Clone, Copy)]
struct ScalarPredecessor {
    state: i32,
    trip: i32,
    duration: u32,
    board_sequence_twice: u32,
    alight_sequence_twice: u32,
    kind: u8,
    _padding: [u8; 3],
}

impl Default for ScalarPredecessor {
    fn default() -> Self {
        Self {
            state: NO_STATE,
            trip: NO_STATE,
            duration: 0,
            board_sequence_twice: 0,
            alight_sequence_twice: 0,
            kind: 0,
            _padding: [0; 3],
        }
    }
}

struct ScalarWorkspace {
    allow_post_ride_transfers: bool,
    epoch: u32,
    active_stop_generation: Vec<u32>,
    active_state_mask: Vec<u8>,
    labels: Vec<ScalarLabel>,
    predecessors: Vec<ScalarPredecessor>,
    destination_generation: Vec<u32>,
    destination_egress: Vec<f64>,
    destination_candidate: Vec<i32>,
    expanded_run_start: Vec<i32>,
    run_predecessor_state: Vec<i32>,
    run_board_sequence: Vec<u32>,
    run_generation: Vec<u32>,
    touched_runs: Vec<u32>,
}

impl ScalarWorkspace {
    fn new(stop_count: usize, run_count: usize) -> Self {
        let state_count = stop_count * STATE_STRIDE;
        Self {
            allow_post_ride_transfers: true,
            epoch: 0,
            active_stop_generation: vec![0; stop_count],
            active_state_mask: vec![0; stop_count],
            labels: vec![ScalarLabel::default(); state_count],
            predecessors: vec![ScalarPredecessor::default(); state_count],
            destination_generation: vec![0; stop_count],
            destination_egress: vec![f64::INFINITY; stop_count],
            destination_candidate: vec![NO_STATE; stop_count],
            expanded_run_start: vec![NO_STATE; run_count],
            run_predecessor_state: vec![NO_STATE; run_count],
            run_board_sequence: vec![0; run_count],
            run_generation: vec![0; run_count],
            touched_runs: Vec::with_capacity(run_count),
        }
    }

    fn ensure_dimensions(&mut self, stops: usize, runs: usize) {
        self.active_stop_generation.resize(stops, 0);
        self.active_state_mask.resize(stops, 0);
        self.labels
            .resize(stops * STATE_STRIDE, ScalarLabel::default());
        self.predecessors
            .resize(stops * STATE_STRIDE, ScalarPredecessor::default());
        self.destination_generation.resize(stops, 0);
        self.destination_egress.resize(stops, f64::INFINITY);
        self.destination_candidate.resize(stops, NO_STATE);
        self.expanded_run_start.resize(runs, NO_STATE);
        self.run_predecessor_state.resize(runs, NO_STATE);
        self.run_board_sequence.resize(runs, 0);
        self.run_generation.resize(runs, 0);
    }

    fn begin_query(&mut self) -> u32 {
        self.touched_runs.clear();
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            for label in &mut self.labels {
                label.generation = 0;
            }
            self.active_stop_generation.fill(0);
            self.destination_generation.fill(0);
            self.run_generation.fill(0);
            self.epoch = 1;
        }
        self.epoch
    }

    fn byte_length(&self) -> usize {
        self.active_stop_generation.len() * std::mem::size_of::<u32>()
            + self.active_state_mask.len() * std::mem::size_of::<u8>()
            + self.labels.len() * std::mem::size_of::<ScalarLabel>()
            + self.predecessors.len() * std::mem::size_of::<ScalarPredecessor>()
            + self.destination_generation.len() * std::mem::size_of::<u32>()
            + self.destination_egress.len() * std::mem::size_of::<f64>()
            + self.destination_candidate.len() * std::mem::size_of::<i32>()
            + self.expanded_run_start.len() * std::mem::size_of::<i32>()
            + self.run_predecessor_state.len() * std::mem::size_of::<i32>()
            + self.run_board_sequence.len() * std::mem::size_of::<u32>()
            + self.run_generation.len() * std::mem::size_of::<u32>()
            + self.touched_runs.capacity() * std::mem::size_of::<u32>()
    }
}

struct ManyWorkspace {
    epoch: u32,
    stop_generation: Vec<u32>,
    active_state_mask: Vec<u8>,
    state_generation: Vec<u32>,
    labels: Vec<f64>,
    predecessors: Vec<ScalarPredecessor>,
    run_generation: Vec<u32>,
    run_boarding_connection: Vec<u32>,
    run_boarding_state: Vec<i32>,
    excluded_trip_generation: Vec<u32>,
}

impl ManyWorkspace {
    fn new(stop_count: usize, run_count: usize, trip_count: usize) -> Self {
        Self {
            epoch: 0,
            stop_generation: vec![0; stop_count],
            active_state_mask: vec![0; stop_count],
            state_generation: vec![0; stop_count * STATE_STRIDE],
            labels: vec![f64::INFINITY; stop_count * STATE_STRIDE],
            // Live overlay chain state is allocated only for the duration of
            // an overlay query. Scheduled many-to-one callers do not pay for
            // predecessor storage in every resident kernel.
            predecessors: Vec::new(),
            run_generation: vec![0; run_count],
            run_boarding_connection: vec![0; run_count],
            run_boarding_state: Vec::new(),
            excluded_trip_generation: vec![0; trip_count],
        }
    }

    fn begin_query(&mut self) -> u32 {
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            self.stop_generation.fill(0);
            self.state_generation.fill(0);
            self.run_generation.fill(0);
            self.excluded_trip_generation.fill(0);
            self.epoch = 1;
        }
        self.epoch
    }

    fn ensure_dimensions(&mut self, stop_count: usize, run_count: usize) {
        if self.stop_generation.len() < stop_count {
            self.stop_generation.resize(stop_count, 0);
            self.active_state_mask.resize(stop_count, 0);
            self.state_generation.resize(stop_count * STATE_STRIDE, 0);
            self.labels.resize(stop_count * STATE_STRIDE, f64::INFINITY);
        }
        if self.run_generation.len() < run_count {
            self.run_generation.resize(run_count, 0);
            self.run_boarding_connection.resize(run_count, 0);
        }
    }

    fn byte_length(&self) -> usize {
        self.stop_generation.len() * std::mem::size_of::<u32>()
            + self.active_state_mask.len() * std::mem::size_of::<u8>()
            + self.state_generation.len() * std::mem::size_of::<u32>()
            + self.labels.len() * std::mem::size_of::<f64>()
            + self.predecessors.len() * std::mem::size_of::<ScalarPredecessor>()
            + self.run_generation.len() * std::mem::size_of::<u32>()
            + self.run_boarding_connection.len() * std::mem::size_of::<u32>()
            + self.run_boarding_state.len() * std::mem::size_of::<i32>()
            + self.excluded_trip_generation.len() * std::mem::size_of::<u32>()
    }
}

#[derive(Clone, Copy)]
struct OverlayScanEvent {
    departure: u32,
    arrival: u32,
    from: usize,
    to: usize,
    run: usize,
    sequence: u32,
    can_board: bool,
    can_alight: bool,
}

struct CompiledTimetableOverlay {
    events: Vec<OverlayScanEvent>,
    run_count: usize,
}

impl CompiledTimetableOverlay {
    fn byte_length(&self) -> usize {
        self.events.capacity() * std::mem::size_of::<OverlayScanEvent>()
    }
}

fn finite_u32_time(value: f64, label: &str) -> napi::Result<u32> {
    if !value.is_finite() || value < 0.0 || value > f64::from(u32::MAX) {
        return Err(Error::from_reason(format!(
            "Rust timetable overlay {label} must be a finite non-negative u32 time."
        )));
    }
    Ok(value.round() as u32)
}

fn compile_timetable_overlay(
    input: &TimetableOverlayManyQueryInput,
    base_stop_count: usize,
) -> napi::Result<CompiledTimetableOverlay> {
    let direction_count = input.service_start_seconds.len();
    if input.direction_offsets.len() != direction_count + 1
        || input.direction_offsets.first().copied() != Some(0)
        || input.direction_offsets[direction_count] as usize != input.direction_stops.len()
        || input.direction_stops.len() != input.direction_stop_offsets_seconds.len()
        || input.service_end_seconds.len() != direction_count
        || input.service_headway_seconds.len() != direction_count
        || input
            .direction_can_board
            .as_ref()
            .is_some_and(|flags| flags.len() != input.direction_stops.len())
        || input
            .direction_can_alight
            .as_ref()
            .is_some_and(|flags| flags.len() != input.direction_stops.len())
        || input
            .direction_offsets
            .windows(2)
            .any(|offsets| offsets[0] > offsets[1])
        || input
            .direction_stops
            .iter()
            .any(|stop| *stop >= input.overlay_stop_count)
    {
        return Err(Error::from_reason(
            "Rust timetable overlay direction arrays are inconsistent.",
        ));
    }

    let query_departure = finite_u32_time(input.departure, "query departure")?;
    let query_horizon = finite_u32_time(input.horizon, "query horizon")?;
    let mut events = Vec::<OverlayScanEvent>::new();
    let mut run_count = 0_usize;
    for direction in 0..direction_count {
        let direction_start = input.direction_offsets[direction] as usize;
        let direction_end = input.direction_offsets[direction + 1] as usize;
        if direction_end.saturating_sub(direction_start) < 2 {
            return Err(Error::from_reason(
                "Each Rust timetable overlay direction must contain at least two stops.",
            ));
        }
        let offsets = &input.direction_stop_offsets_seconds[direction_start..direction_end];
        if offsets
            .iter()
            .any(|seconds| !seconds.is_finite() || *seconds < 0.0)
            || offsets.windows(2).any(|times| times[0] > times[1])
            || offsets.first().copied() != Some(0.0)
        {
            return Err(Error::from_reason(
                "Rust timetable overlay stop offsets must start at zero and be finite and nondecreasing.",
            ));
        }
        let service_start = input.service_start_seconds[direction];
        let service_end = input.service_end_seconds[direction];
        let headway = input.service_headway_seconds[direction];
        if !service_start.is_finite()
            || !service_end.is_finite()
            || !headway.is_finite()
            || service_start < 0.0
            || service_end < service_start
            || headway <= 0.0
        {
            return Err(Error::from_reason(
                "Rust timetable overlay service windows and headways are inconsistent.",
            ));
        }
        finite_u32_time(service_start, "service start")?;
        finite_u32_time(service_end, "service end")?;
        finite_u32_time(headway, "service headway")?;

        // A run may start before the query and still expose a later boardable
        // segment. Jump directly to the first such finite run instead of
        // expanding the earlier portion of a long service window.
        let last_offset = *offsets.last().unwrap_or(&0.0);
        let earliest_relevant_start = f64::from(query_departure) - last_offset;
        let first_instance = if earliest_relevant_start > service_start {
            ((earliest_relevant_start - service_start) / headway).ceil()
        } else {
            0.0
        };
        if first_instance > f64::from(u32::MAX) {
            return Err(Error::from_reason(
                "Rust timetable overlay service expansion exceeds the finite run domain.",
            ));
        }
        let mut instance = first_instance as u64;
        loop {
            let trip_start = service_start + instance as f64 * headway;
            if trip_start > service_end || trip_start + offsets[0] > f64::from(query_horizon) {
                break;
            }
            let local_run = run_count;
            let mut emitted = false;
            for segment in direction_start..direction_end - 1 {
                let offset_index = segment - direction_start;
                let departure = trip_start + offsets[offset_index];
                if departure < f64::from(query_departure) {
                    continue;
                }
                if departure > f64::from(query_horizon) {
                    break;
                }
                let arrival = trip_start + offsets[offset_index + 1];
                events.push(OverlayScanEvent {
                    departure: finite_u32_time(departure, "connection departure")?,
                    arrival: finite_u32_time(arrival, "connection arrival")?,
                    from: base_stop_count + input.direction_stops[segment] as usize,
                    to: base_stop_count + input.direction_stops[segment + 1] as usize,
                    run: local_run,
                    sequence: offset_index as u32,
                    can_board: input
                        .direction_can_board
                        .as_ref()
                        .map(|flags| flags[segment] == 1)
                        .unwrap_or(true),
                    can_alight: input
                        .direction_can_alight
                        .as_ref()
                        .map(|flags| flags[segment + 1] == 1)
                        .unwrap_or(true),
                });
                emitted = true;
                if events.len() > MAX_OVERLAY_CONNECTIONS {
                    return Err(Error::from_reason(format!(
                        "Rust timetable overlay exceeds the {MAX_OVERLAY_CONNECTIONS}-connection query limit."
                    )));
                }
            }
            if emitted {
                run_count = run_count.checked_add(1).ok_or_else(|| {
                    Error::from_reason("Rust timetable overlay run count overflowed.")
                })?;
            }
            instance = instance.checked_add(1).ok_or_else(|| {
                Error::from_reason("Rust timetable overlay service instance overflowed.")
            })?;
        }
    }
    events.sort_unstable_by_key(|event| (event.departure, event.run, event.sequence));
    Ok(CompiledTimetableOverlay { events, run_count })
}

struct ProfileLabel {
    state: u32,
    arrival: f64,
    boardings: u16,
    walking_seconds: f64,
    predecessor: i32,
    kind: u8,
    trip: i32,
    board_sequence: f64,
    alight_sequence: f64,
    duration: u32,
    next: i32,
    active: bool,
}

struct ProfileWorkspace {
    epoch: u32,
    transfer_generation: Vec<u32>,
    transfer_label: Vec<i32>,
    frontier_generation: Vec<u32>,
    frontier_head: Vec<i32>,
    run_generation: Vec<u32>,
    labels: Vec<ProfileLabel>,
    overflowed: bool,
}

impl ProfileWorkspace {
    fn new(state_count: usize, run_count: usize) -> Self {
        Self {
            epoch: 0,
            transfer_generation: vec![0; state_count],
            transfer_label: vec![NO_STATE; state_count],
            frontier_generation: vec![0; state_count],
            frontier_head: vec![NO_STATE; state_count],
            run_generation: vec![0; run_count],
            labels: Vec::with_capacity(32_768),
            overflowed: false,
        }
    }

    fn begin_query(&mut self) -> u32 {
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            self.transfer_generation.fill(0);
            self.run_generation.fill(0);
            self.frontier_generation.fill(0);
            self.epoch = 1;
        }
        self.labels.clear();
        self.overflowed = false;
        self.epoch
    }

    fn next_round(&mut self) -> u32 {
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            self.transfer_generation.fill(0);
            self.run_generation.fill(0);
            self.frontier_generation.fill(0);
            self.epoch = 1;
        }
        self.epoch
    }

    fn byte_length(&self) -> usize {
        self.transfer_generation.len() * std::mem::size_of::<u32>()
            + self.transfer_label.len() * std::mem::size_of::<i32>()
            + self.frontier_generation.len() * std::mem::size_of::<u32>()
            + self.frontier_head.len() * std::mem::size_of::<i32>()
            + self.run_generation.len() * std::mem::size_of::<u32>()
            + self.labels.capacity() * std::mem::size_of::<ProfileLabel>()
    }
}

#[derive(Default)]
struct ParetoStats {
    scanned_departures: u32,
    relaxed_stops: u32,
    expanded_trip_runs: u32,
    dominated_trip_boardings: u32,
    explicit_transfer_checks: u32,
    dominated_candidate_labels: u32,
    dominated_existing_labels: u32,
    terminal_candidates_evaluated: u32,
}

struct ParetoBest {
    deadline_objective: bool,
    arrival: f64,
    boardings: u16,
    walking_seconds: f64,
    generalized_seconds: f64,
    label: i32,
    destination_index: i32,
    collect_alternatives: bool,
    minimum_arrival: f64,
    prune_dominated_alternatives: bool,
    departure_upper_bound: f64,
}

impl ParetoBest {
    fn pruning_bound(&self) -> f64 {
        if self.collect_alternatives || self.deadline_objective {
            f64::INFINITY
        } else {
            self.generalized_seconds
        }
    }
}

#[derive(Default)]
struct SearchStats {
    scanned_departures: u32,
    relaxed_stops: u32,
    expanded_trip_runs: u32,
    dominated_trip_boardings: u32,
    explicit_transfer_checks: u32,
}

struct BestState {
    arrival: f64,
    boardings: u16,
    walking_seconds: f64,
    state: i32,
    destination_index: i32,
}

impl Default for BestState {
    fn default() -> Self {
        Self {
            arrival: f64::INFINITY,
            boardings: u16::MAX,
            walking_seconds: f64::INFINITY,
            state: NO_STATE,
            destination_index: NO_STATE,
        }
    }
}

fn scalar_objective_better(
    arrival: f64,
    boardings: u16,
    walking_seconds: f64,
    retained_arrival: f64,
    retained_boardings: u16,
    retained_walking_seconds: f64,
) -> bool {
    arrival < retained_arrival
        || (arrival == retained_arrival
            && (boardings < retained_boardings
                || (boardings == retained_boardings && walking_seconds < retained_walking_seconds)))
}

#[allow(clippy::too_many_arguments)]
fn relax_connection_scan(
    workspace: &mut ScalarWorkspace,
    epoch: u32,
    best: &mut BestState,
    stats: &mut SearchStats,
    stop: usize,
    arrival: f64,
    has_ride: bool,
    egress_ready: bool,
    needs_board_slack: bool,
    from_state: i32,
    kind: u8,
    trip: i32,
    board_sequence: f64,
    alight_sequence: f64,
    duration: u32,
) -> i32 {
    let state = stop * STATE_STRIDE
        + usize::from(has_ride) * 4
        + usize::from(egress_ready) * 2
        + usize::from(needs_board_slack);
    let predecessor_boardings = if from_state >= 0 {
        workspace.labels[from_state as usize].boardings
    } else {
        0
    };
    let predecessor_walking_seconds = if from_state >= 0 {
        workspace.labels[from_state as usize].walking_seconds
    } else {
        0
    };
    let boardings = predecessor_boardings.saturating_add(u16::from(kind == 2));
    let walking_seconds = predecessor_walking_seconds.saturating_add(if kind == 1 || kind == 3 {
        u16::try_from(duration).unwrap_or(u16::MAX)
    } else {
        0
    });
    let retained = workspace.labels[state];
    if retained.generation == epoch
        && !scalar_objective_better(
            arrival,
            boardings,
            f64::from(walking_seconds),
            retained.arrival,
            retained.boardings,
            f64::from(retained.walking_seconds),
        )
    {
        return NO_STATE;
    }
    if arrival > best.arrival {
        return NO_STATE;
    }
    if workspace.active_stop_generation[stop] != epoch {
        workspace.active_stop_generation[stop] = epoch;
        workspace.active_state_mask[stop] = 0;
    }
    workspace.active_state_mask[stop] |= 1 << (state & (STATE_STRIDE - 1));
    workspace.labels[state] = ScalarLabel {
        arrival,
        generation: epoch,
        boardings,
        walking_seconds,
    };
    workspace.predecessors[state] = ScalarPredecessor {
        state: from_state,
        trip,
        duration,
        board_sequence_twice: (board_sequence * 2.0) as u32,
        alight_sequence_twice: (alight_sequence * 2.0) as u32,
        kind,
        _padding: [0; 3],
    };
    // A query cannot relax more than the source-bounded event/state product,
    // which is far below u32::MAX under TimetableKernel's admission guards.
    stats.relaxed_stops += 1;
    let destination_index = workspace.destination_candidate[stop];
    if workspace.destination_generation[stop] == epoch
        && destination_index >= 0
        && has_ride
        && egress_ready
        && (workspace.allow_post_ride_transfers || kind != 1)
    {
        let destination_arrival = arrival + workspace.destination_egress[stop];
        let destination_walking_seconds =
            f64::from(walking_seconds) + workspace.destination_egress[stop];
        if scalar_objective_better(
            destination_arrival,
            boardings,
            destination_walking_seconds,
            best.arrival,
            best.boardings,
            best.walking_seconds,
        ) {
            best.arrival = destination_arrival;
            best.boardings = boardings;
            best.walking_seconds = destination_walking_seconds;
            best.state = state as i32;
            best.destination_index = destination_index;
        }
    }
    state as i32
}

#[cfg(test)]
mod scalar_objective_tests {
    use super::scalar_objective_better;

    #[test]
    fn orders_arrival_then_boardings_then_walking_and_keeps_stable_ties() {
        assert!(scalar_objective_better(99.0, 3, 900.0, 100.0, 1, 60.0));
        assert!(scalar_objective_better(100.0, 1, 900.0, 100.0, 2, 60.0));
        assert!(scalar_objective_better(100.0, 2, 59.0, 100.0, 2, 60.0));
        assert!(!scalar_objective_better(100.0, 2, 60.0, 100.0, 2, 60.0));
    }
}

fn departure_event_lower_bound(
    events: &[DepartureEvent],
    mut low: usize,
    mut high: usize,
    value: f64,
) -> usize {
    while low < high {
        let middle = (low + high) >> 1;
        if (events[middle].departure as f64) < value {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

#[inline]
fn earliest_boardable_departure(
    departure_offset: &[u32],
    departure_events: &[DepartureEvent],
    origin_stops: &[u32],
    origin_walk_seconds: &[f64],
    departure: f64,
) -> f64 {
    origin_stops
        .iter()
        .zip(origin_walk_seconds)
        .filter_map(|(&stop, &walk_seconds)| {
            let stop = stop as usize;
            let end = departure_offset[stop + 1] as usize;
            let cursor = departure_event_lower_bound(
                departure_events,
                departure_offset[stop] as usize,
                end,
                departure + walk_seconds,
            );
            if cursor < end {
                Some(departure_events[cursor].departure as f64)
            } else {
                None
            }
        })
        .fold(f64::INFINITY, f64::min)
}

fn scan_time_lower_bound(times: &[u32], value: f64) -> usize {
    let mut low = 0;
    let mut high = times.len();
    while low < high {
        let middle = (low + high) >> 1;
        if (times[middle] as f64) < value {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

fn scan_time_upper_bound(times: &[u32], value: f64) -> usize {
    let mut low = 0;
    let mut high = times.len();
    while low < high {
        let middle = (low + high) >> 1;
        if (times[middle] as f64) <= value {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

#[inline]
fn retain_reverse_origin_offset(
    workspace: &mut ScalarWorkspace,
    epoch: u32,
    stop: usize,
    offset: f64,
) {
    let label = &mut workspace.labels[stop * STATE_STRIDE + (STATE_STRIDE - 2)];
    if label.generation != epoch || offset < label.arrival {
        label.generation = epoch;
        label.arrival = offset;
    }
}

#[inline]
fn relax_reverse_post_ride_deadline(
    workspace: &mut ScalarWorkspace,
    epoch: u32,
    stats: &mut SearchStats,
    stop: usize,
    deadline: f64,
    earliest: f64,
) {
    if deadline < earliest {
        return;
    }
    if workspace.destination_generation[stop] == epoch
        && deadline <= workspace.destination_egress[stop]
    {
        return;
    }
    workspace.destination_generation[stop] = epoch;
    workspace.destination_egress[stop] = deadline;
    stats.relaxed_stops = stats.relaxed_stops.saturating_add(1);
}

#[allow(clippy::too_many_arguments)]
fn relax_reverse_transfer_target_deadline(
    workspace: &mut ScalarWorkspace,
    epoch: u32,
    stats: &mut SearchStats,
    target: usize,
    deadline: f64,
    earliest: f64,
    reverse_transfer_offset: &[u32],
    reverse_transfer_edges: &[TransferEdge],
) {
    if deadline < earliest {
        return;
    }
    let label = &mut workspace.labels[target * STATE_STRIDE];
    if label.generation == epoch && deadline <= label.arrival {
        return;
    }
    label.generation = epoch;
    label.arrival = deadline;
    let base_stop_count = reverse_transfer_offset.len() - 1;
    let base_target = target % base_stop_count;
    let layer_offset = target - base_target;
    let start = reverse_transfer_offset[base_target] as usize;
    let end = reverse_transfer_offset[base_target + 1] as usize;
    stats.explicit_transfer_checks = stats
        .explicit_transfer_checks
        .saturating_add((end - start) as u32);
    for edge in &reverse_transfer_edges[start..end] {
        relax_reverse_post_ride_deadline(
            workspace,
            epoch,
            stats,
            layer_offset + edge.stop(),
            deadline - f64::from(edge.duration()),
            earliest,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn expand_connection_scan_transfer_edges(
    workspace: &mut ScalarWorkspace,
    epoch: u32,
    best: &mut BestState,
    stats: &mut SearchStats,
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
    stop: usize,
    arrival: f64,
    has_ride: bool,
    source_state: i32,
) {
    let start = transfer_offset[stop] as usize;
    let end = transfer_offset[stop + 1] as usize;
    stats.explicit_transfer_checks += (end - start) as u32;
    for edge in &transfer_edges[start..end] {
        let target = edge.stop();
        let duration = edge.duration();
        relax_connection_scan(
            workspace,
            epoch,
            best,
            stats,
            target,
            arrival + duration as f64,
            has_ride,
            has_ride,
            !has_ride,
            source_state,
            1,
            NO_STATE,
            0.0,
            0.0,
            duration,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn relax_many_record(
    workspace: &mut ManyWorkspace,
    epoch: u32,
    stats: &mut SearchStats,
    stop: usize,
    arrival: f64,
    has_ride: bool,
    egress_ready: bool,
    needs_board_slack: bool,
    horizon: f64,
    allow_terminal_beyond_horizon: bool,
    predecessor: i32,
    kind: u8,
    trip: i32,
    board_sequence: f64,
    alight_sequence: f64,
    duration: u32,
) -> i32 {
    if arrival > horizon && !allow_terminal_beyond_horizon {
        return NO_STATE;
    }
    let state = stop * STATE_STRIDE
        + usize::from(has_ride) * 4
        + usize::from(egress_ready) * 2
        + usize::from(needs_board_slack);
    if workspace.state_generation[state] == epoch && arrival >= workspace.labels[state] {
        return NO_STATE;
    }
    if workspace.stop_generation[stop] != epoch {
        workspace.stop_generation[stop] = epoch;
        workspace.active_state_mask[stop] = 0;
    }
    workspace.state_generation[state] = epoch;
    workspace.active_state_mask[stop] |= 1 << (state & (STATE_STRIDE - 1));
    workspace.labels[state] = arrival;
    workspace.predecessors[state] = ScalarPredecessor {
        state: predecessor,
        trip,
        duration,
        board_sequence_twice: (board_sequence * 2.0) as u32,
        alight_sequence_twice: (alight_sequence * 2.0) as u32,
        kind,
        _padding: [0; 3],
    };
    stats.relaxed_stops = stats.relaxed_stops.saturating_add(1);
    state as i32
}

#[allow(clippy::too_many_arguments)]
fn relax_many(
    workspace: &mut ManyWorkspace,
    epoch: u32,
    stats: &mut SearchStats,
    stop: usize,
    arrival: f64,
    has_ride: bool,
    egress_ready: bool,
    needs_board_slack: bool,
    horizon: f64,
    allow_terminal_beyond_horizon: bool,
) -> bool {
    if arrival > horizon && !allow_terminal_beyond_horizon {
        return false;
    }
    let state = stop * STATE_STRIDE
        + usize::from(has_ride) * 4
        + usize::from(egress_ready) * 2
        + usize::from(needs_board_slack);
    if workspace.state_generation[state] == epoch && arrival >= workspace.labels[state] {
        return false;
    }
    if workspace.stop_generation[stop] != epoch {
        workspace.stop_generation[stop] = epoch;
        workspace.active_state_mask[stop] = 0;
    }
    workspace.state_generation[state] = epoch;
    workspace.active_state_mask[stop] |= 1 << (state & (STATE_STRIDE - 1));
    workspace.labels[state] = arrival;
    stats.relaxed_stops = stats.relaxed_stops.saturating_add(1);
    true
}

#[allow(clippy::too_many_arguments)]
fn expand_many_transfer_edges(
    workspace: &mut ManyWorkspace,
    epoch: u32,
    stats: &mut SearchStats,
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
    stop: usize,
    arrival: f64,
    has_ride: bool,
    horizon: f64,
) {
    let base_stop_count = transfer_offset.len() - 1;
    let base_stop = stop % base_stop_count;
    let layer_offset = stop - base_stop;
    let start = transfer_offset[base_stop] as usize;
    let end = transfer_offset[base_stop + 1] as usize;
    stats.explicit_transfer_checks = stats
        .explicit_transfer_checks
        .saturating_add((end - start) as u32);
    for edge in &transfer_edges[start..end] {
        let target = layer_offset + edge.stop();
        relax_many(
            workspace,
            epoch,
            stats,
            target,
            arrival + f64::from(edge.duration()),
            has_ride,
            has_ride,
            !has_ride,
            horizon,
            has_ride,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn expand_many_combined_transfer_edges_chain(
    workspace: &mut ManyWorkspace,
    epoch: u32,
    stats: &mut SearchStats,
    base_stop_count: usize,
    base_transfer_offset: &[u32],
    base_transfer_edges: &[TransferEdge],
    supplemental_transfer_offset: &[u32],
    supplemental_transfer_edges: &[TransferEdge],
    stop: usize,
    arrival: f64,
    has_ride: bool,
    horizon: f64,
    source_state: i32,
) {
    let combined_stop_count = supplemental_transfer_offset.len() - 1;
    let base_stop = stop % combined_stop_count;
    let layer_offset = stop - base_stop;
    if base_stop < base_stop_count {
        let start = base_transfer_offset[base_stop] as usize;
        let end = base_transfer_offset[base_stop + 1] as usize;
        stats.explicit_transfer_checks = stats
            .explicit_transfer_checks
            .saturating_add((end - start) as u32);
        for edge in &base_transfer_edges[start..end] {
            let duration = edge.duration();
            relax_many_record(
                workspace,
                epoch,
                stats,
                layer_offset + edge.stop(),
                arrival + f64::from(duration),
                has_ride,
                has_ride,
                !has_ride,
                horizon,
                has_ride,
                source_state,
                1,
                NO_STATE,
                0.0,
                0.0,
                duration,
            );
        }
    }
    let start = supplemental_transfer_offset[base_stop] as usize;
    let end = supplemental_transfer_offset[base_stop + 1] as usize;
    stats.explicit_transfer_checks = stats
        .explicit_transfer_checks
        .saturating_add((end - start) as u32);
    for edge in &supplemental_transfer_edges[start..end] {
        let duration = edge.duration();
        // Positive explicit edges already carry their interchange duration.
        // A zero-second supplemental edge is an identity bridge between the
        // resident and overlay domains, so retain generic post-ride boarding
        // slack and keep the equal-departure scan order independent.
        let needs_board_slack = has_ride && duration == 0;
        relax_many_record(
            workspace,
            epoch,
            stats,
            layer_offset + edge.stop(),
            arrival + f64::from(duration),
            has_ride,
            has_ride,
            needs_board_slack,
            horizon,
            has_ride,
            source_state,
            1,
            NO_STATE,
            0.0,
            0.0,
            duration,
        );
    }
}

fn generalized_seconds(
    arrival: f64,
    boardings: u16,
    walking_seconds: f64,
    transfer_penalty_seconds: f64,
    walk_reluctance: f64,
) -> f64 {
    arrival
        + f64::from(boardings.saturating_sub(1)) * transfer_penalty_seconds
        + walking_seconds * walk_reluctance
}

fn profile_label_chain(labels: &[ProfileLabel], mut label: i32) -> Vec<JourneyChainStep> {
    let mut chain = Vec::new();
    while label >= 0 {
        let current = &labels[label as usize];
        let stop = (current.state as usize / STATE_STRIDE) as i32;
        if current.kind == 3 {
            chain.push((
                3,
                NO_STATE,
                stop,
                current.trip,
                0.0,
                0.0,
                current.duration,
                current.arrival,
            ));
            break;
        }
        if current.predecessor < 0 {
            break;
        }
        let from_stop = (labels[current.predecessor as usize].state as usize / STATE_STRIDE) as i32;
        chain.push((
            current.kind as u32,
            from_stop,
            stop,
            current.trip,
            current.board_sequence,
            current.alight_sequence,
            current.duration,
            current.arrival,
        ));
        label = current.predecessor;
    }
    chain.reverse();
    chain
}

fn collect_pareto_alternatives(
    labels: &[ProfileLabel],
    destinations: &ScalarWorkspace,
    destination_epoch: u32,
    arrival_upper_bound: f64,
) -> Vec<TimetableParetoAlternative> {
    // A terminal label remains a valid witness even when a later boarding
    // round has replaced the stop's frontier. Compare completed journeys
    // across all rounds before reconstructing their paths.
    let mut frontier: Vec<(usize, f64, u16, f64, u32)> = Vec::new();
    for (index, label) in labels.iter().enumerate() {
        let stop = label.state as usize / STATE_STRIDE;
        if !label.active
            || (!destinations.allow_post_ride_transfers && label.kind == 1)
            || (label.state as usize % STATE_STRIDE) & 6 != 6
            || destinations.destination_generation[stop] != destination_epoch
            || destinations.destination_candidate[stop] < 0
        {
            continue;
        }
        let arrival = label.arrival + destinations.destination_egress[stop];
        let walking = label.walking_seconds + destinations.destination_egress[stop];
        if arrival > arrival_upper_bound
            || frontier
                .iter()
                .any(|other| other.1 <= arrival && other.2 <= label.boardings && other.3 <= walking)
        {
            continue;
        }
        frontier.retain(|other| {
            !(arrival <= other.1 && label.boardings <= other.2 && walking <= other.3)
        });
        frontier.push((
            index,
            arrival,
            label.boardings,
            walking,
            destinations.destination_candidate[stop] as u32,
        ));
    }
    frontier.sort_by(|left, right| {
        left.1
            .total_cmp(&right.1)
            .then(left.2.cmp(&right.2))
            .then(left.3.total_cmp(&right.3))
            .then(left.0.cmp(&right.0))
    });
    frontier
        .into_iter()
        .map(|(label, arrival, boardings, walking, destination)| {
            let chain = profile_label_chain(labels, label as i32);
            TimetableParetoAlternative {
                best_arrival: arrival,
                best_boardings: boardings as u32,
                best_destination_index: destination,
                best_walking_seconds: walking,
                chain_kinds: chain.iter().map(|step| step.0).collect(),
                chain_from_stops: chain.iter().map(|step| step.1).collect(),
                chain_to_stops: chain.iter().map(|step| step.2).collect(),
                chain_trip_or_candidate: chain.iter().map(|step| step.3).collect(),
                chain_board_sequences: chain.iter().map(|step| step.4).collect(),
                chain_alight_sequences: chain.iter().map(|step| step.5).collect(),
                chain_durations: chain.iter().map(|step| step.6).collect(),
                chain_arrivals: chain.iter().map(|step| step.7).collect(),
            }
        })
        .collect()
}

fn generalized_candidate_better(
    generalized: f64,
    arrival: f64,
    boardings: u16,
    walking_seconds: f64,
    best: &ParetoBest,
) -> bool {
    if best.deadline_objective {
        return boardings < best.boardings
            || (boardings == best.boardings
                && (walking_seconds < best.walking_seconds
                    || (walking_seconds == best.walking_seconds && arrival < best.arrival)));
    }
    generalized < best.generalized_seconds
        || (generalized == best.generalized_seconds
            && (arrival < best.arrival
                || (arrival == best.arrival
                    && (boardings < best.boardings
                        || (boardings == best.boardings
                            && walking_seconds < best.walking_seconds)))))
}

#[allow(clippy::too_many_arguments)]
fn add_round_label(
    workspace: &mut ProfileWorkspace,
    epoch: u32,
    destination_workspace: &ScalarWorkspace,
    destination_epoch: u32,
    best: &mut ParetoBest,
    stats: &mut ParetoStats,
    stop: usize,
    arrival: f64,
    has_ride: bool,
    egress_ready: bool,
    needs_board_slack: bool,
    predecessor: i32,
    kind: u8,
    trip: i32,
    board_sequence: f64,
    alight_sequence: f64,
    duration: u32,
    arrival_upper_bound: f64,
    boarding_upper_bound: u16,
    transfer_penalty_seconds: f64,
    walk_reluctance: f64,
) -> i32 {
    let predecessor_boardings = if predecessor >= 0 {
        workspace.labels[predecessor as usize].boardings
    } else {
        0
    };
    let boardings = predecessor_boardings.saturating_add(u16::from(kind == 2));
    if boardings > boarding_upper_bound || arrival > arrival_upper_bound {
        return NO_STATE;
    }
    let walking_seconds = if predecessor >= 0 {
        workspace.labels[predecessor as usize].walking_seconds
    } else {
        0.0
    } + if kind == 1 || kind == 3 {
        duration as f64
    } else {
        0.0
    };
    // Every completion is no earlier than the scalar earliest-arrival proof,
    // and cannot undo boardings or walking already incurred. Keep equality to
    // preserve the deterministic primary witness, but discard a strict loss.
    let completion_arrival_bound = arrival.max(best.minimum_arrival);
    if best.prune_dominated_alternatives
        && best.arrival <= completion_arrival_bound
        && best.boardings <= boardings
        && best.walking_seconds <= walking_seconds
        && (best.arrival < completion_arrival_bound
            || best.boardings < boardings
            || best.walking_seconds < walking_seconds)
    {
        stats.dominated_candidate_labels = stats.dominated_candidate_labels.saturating_add(1);
        return NO_STATE;
    }
    if generalized_seconds(
        arrival,
        boardings,
        walking_seconds,
        transfer_penalty_seconds,
        walk_reluctance,
    ) > best.pruning_bound()
    {
        return NO_STATE;
    }
    let state = stop * STATE_STRIDE
        + usize::from(has_ride) * 4
        + usize::from(egress_ready) * 2
        + usize::from(needs_board_slack);
    if workspace.frontier_generation[state] != epoch {
        workspace.frontier_generation[state] = epoch;
        workspace.frontier_head[state] = NO_STATE;
    }
    let mut previous = NO_STATE;
    let mut existing = workspace.frontier_head[state];
    while existing >= 0 {
        let index = existing as usize;
        let next = workspace.labels[index].next;
        let retained = &workspace.labels[index];
        if retained.active
            && retained.arrival <= arrival
            && retained.walking_seconds <= walking_seconds
        {
            stats.dominated_candidate_labels = stats.dominated_candidate_labels.saturating_add(1);
            return NO_STATE;
        }
        if retained.active
            && arrival <= retained.arrival
            && walking_seconds <= retained.walking_seconds
        {
            workspace.labels[index].active = false;
            if previous < 0 {
                workspace.frontier_head[state] = next;
            } else {
                workspace.labels[previous as usize].next = next;
            }
            stats.dominated_existing_labels = stats.dominated_existing_labels.saturating_add(1);
            existing = next;
            continue;
        }
        previous = existing;
        existing = next;
    }
    if workspace.labels.len() >= MAX_PARETO_LABELS {
        workspace.overflowed = true;
        return NO_STATE;
    }
    let label = workspace.labels.len() as i32;
    workspace.labels.push(ProfileLabel {
        state: state as u32,
        arrival,
        boardings,
        walking_seconds,
        predecessor,
        kind,
        trip,
        board_sequence,
        alight_sequence,
        duration,
        next: workspace.frontier_head[state],
        active: true,
    });
    workspace.frontier_head[state] = label;
    stats.relaxed_stops = stats.relaxed_stops.saturating_add(1);
    if destination_workspace.destination_generation[stop] == destination_epoch
        && destination_workspace.destination_candidate[stop] >= 0
        && has_ride
        && egress_ready
        && (destination_workspace.allow_post_ride_transfers || kind != 1)
    {
        let destination_arrival = arrival + destination_workspace.destination_egress[stop];
        if destination_arrival <= arrival_upper_bound {
            let destination_walking =
                walking_seconds + destination_workspace.destination_egress[stop];
            let generalized = generalized_seconds(
                destination_arrival,
                boardings,
                destination_walking,
                transfer_penalty_seconds,
                walk_reluctance,
            );
            stats.terminal_candidates_evaluated =
                stats.terminal_candidates_evaluated.saturating_add(1);
            if generalized_candidate_better(
                generalized,
                destination_arrival,
                boardings,
                destination_walking,
                best,
            ) {
                best.arrival = destination_arrival;
                best.boardings = boardings;
                best.walking_seconds = destination_walking;
                best.generalized_seconds = generalized;
                best.label = label;
                best.destination_index = destination_workspace.destination_candidate[stop];
            }
        }
    }
    label
}

#[allow(clippy::too_many_arguments)]
fn expand_round_transfers(
    workspace: &mut ProfileWorkspace,
    epoch: u32,
    destination_workspace: &ScalarWorkspace,
    destination_epoch: u32,
    best: &mut ParetoBest,
    stats: &mut ParetoStats,
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
    stop_deadlines: &[u32],
    stop: usize,
    arrival: f64,
    has_ride: bool,
    source_label: i32,
    arrival_upper_bound: f64,
    boarding_upper_bound: u16,
    transfer_penalty_seconds: f64,
    walk_reluctance: f64,
) {
    let start = transfer_offset[stop] as usize;
    let end = transfer_offset[stop + 1] as usize;
    stats.explicit_transfer_checks = stats
        .explicit_transfer_checks
        .saturating_add((end - start) as u32);
    for edge in &transfer_edges[start..end] {
        let target = edge.stop();
        let duration = edge.duration();
        let target_arrival = arrival + f64::from(duration);
        if !deadline_allows(stop_deadlines[target], target_arrival) {
            continue;
        }
        add_round_label(
            workspace,
            epoch,
            destination_workspace,
            destination_epoch,
            best,
            stats,
            target,
            target_arrival,
            has_ride,
            has_ride,
            !has_ride,
            source_label,
            1,
            NO_STATE,
            0.0,
            0.0,
            duration,
            arrival_upper_bound,
            boarding_upper_bound,
            transfer_penalty_seconds,
            walk_reluctance,
        );
        if workspace.overflowed {
            return;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_marked_run_round(
    workspace: &mut ProfileWorkspace,
    epoch: u32,
    previous_labels: &mut Vec<i32>,
    round: u16,
    destination_workspace: &ScalarWorkspace,
    destination_epoch: u32,
    best: &mut ParetoBest,
    stats: &mut ParetoStats,
    departure_seconds: &[u32],
    arrival_seconds: &[u32],
    from_stop: &[u32],
    to_stop: &[u32],
    sequence: &[u32],
    segment_trip: &[u32],
    segment_run: &[u32],
    continuity_break: &[u8],
    can_board: &[u8],
    can_alight: &[u8],
    departure_offset: &[u32],
    departure_events: &[DepartureEvent],
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
    forbidden_same_stop: &[u8],
    same_stop_transfer_minimum: &[u32],
    run_start: &[u32],
    run_end: &[u32],
    stop_deadlines: &[u32],
    feasible_runs: &[u8],
    arrival_upper_bound: f64,
    boarding_upper_bound: u16,
    transfer_penalty_seconds: f64,
    walk_reluctance: f64,
) -> Vec<i32> {
    let mut touched_stops = Vec::with_capacity(previous_labels.len());
    let mut global_minimum_walking = f64::INFINITY;
    for label in previous_labels.drain(..) {
        if !workspace.labels[label as usize].active {
            continue;
        }
        let state = workspace.labels[label as usize].state as usize;
        global_minimum_walking =
            global_minimum_walking.min(workspace.labels[label as usize].walking_seconds);
        if workspace.transfer_generation[state] != epoch {
            workspace.transfer_generation[state] = epoch;
            workspace.transfer_label[state] = NO_STATE;
            touched_stops.push(state / STATE_STRIDE);
        }
        workspace.labels[label as usize].next = workspace.transfer_label[state];
        workspace.transfer_label[state] = label;
    }
    touched_stops.sort_unstable();
    touched_stops.dedup();
    let mut touched_runs = Vec::new();
    for stop in touched_stops {
        let mut earliest_ready = f64::INFINITY;
        let mut minimum_walking = f64::INFINITY;
        for flags in 0..STATE_STRIDE {
            if flags & 4 != 0 && forbidden_same_stop[stop] == 1 {
                continue;
            }
            let state = stop * STATE_STRIDE + flags;
            if workspace.transfer_generation[state] != epoch {
                continue;
            }
            let mut label = workspace.transfer_label[state];
            while label >= 0 {
                let current = &workspace.labels[label as usize];
                earliest_ready = earliest_ready.min(boarding_ready_time(
                    current.arrival,
                    flags & 4 != 0,
                    flags & 1 != 0,
                    same_stop_transfer_minimum[stop],
                ));
                minimum_walking = minimum_walking.min(current.walking_seconds);
                label = current.next;
            }
        }
        if !earliest_ready.is_finite() || earliest_ready > arrival_upper_bound {
            continue;
        }
        let mut cursor = departure_event_lower_bound(
            departure_events,
            departure_offset[stop] as usize,
            departure_offset[stop + 1] as usize,
            earliest_ready,
        );
        let end = departure_offset[stop + 1] as usize;
        let latest_objective_departure = best.pruning_bound()
            - f64::from(round.saturating_sub(1)) * transfer_penalty_seconds
            - minimum_walking * walk_reluctance;
        while cursor < end {
            let event = departure_events[cursor];
            cursor += 1;
            if event.departure as f64
                > arrival_upper_bound
                    .min(latest_objective_departure)
                    .min(best.departure_upper_bound)
            {
                break;
            }
            let run = event.run as usize;
            if feasible_runs[run] == 0 {
                continue;
            }
            if workspace.run_generation[run] == epoch {
                continue;
            }
            workspace.run_generation[run] = epoch;
            touched_runs.push(run);
        }
    }
    let round_label_start = workspace.labels.len();
    touched_runs.sort_unstable_by_key(|run| departure_seconds[run_start[*run] as usize]);
    for run in touched_runs {
        let mut predecessor = NO_STATE;
        let mut predecessor_walking = f64::INFINITY;
        let mut boarding = 0_usize;
        for connection in run_start[run] as usize..run_end[run] as usize {
            let connection_departure = departure_seconds[connection] as f64;
            let latest_objective_departure = best.pruning_bound()
                - f64::from(round.saturating_sub(1)) * transfer_penalty_seconds
                - global_minimum_walking * walk_reluctance;
            if connection_departure
                > arrival_upper_bound
                    .min(latest_objective_departure)
                    .min(best.departure_upper_bound)
            {
                break;
            }
            stats.scanned_departures += 1;
            let stop = from_stop[connection] as usize;
            if can_board[connection] == 1 {
                let mut candidate = NO_STATE;
                let mut candidate_walking = predecessor_walking;
                for flags in 0..STATE_STRIDE {
                    if flags & 4 != 0 && forbidden_same_stop[stop] == 1 {
                        continue;
                    }
                    let state = stop * STATE_STRIDE + flags;
                    if workspace.transfer_generation[state] != epoch {
                        continue;
                    }
                    let mut label = workspace.transfer_label[state];
                    while label >= 0 {
                        let current = &workspace.labels[label as usize];
                        if boarding_ready_time(
                            current.arrival,
                            flags & 4 != 0,
                            flags & 1 != 0,
                            same_stop_transfer_minimum[stop],
                        ) <= connection_departure
                            && current.walking_seconds < candidate_walking
                        {
                            candidate = label;
                            candidate_walking = current.walking_seconds;
                        }
                        label = current.next;
                    }
                }
                if candidate >= 0 {
                    predecessor = candidate;
                    predecessor_walking = candidate_walking;
                    boarding = connection;
                    stats.expanded_trip_runs = stats.expanded_trip_runs.saturating_add(1);
                } else if predecessor >= 0 {
                    stats.dominated_trip_boardings =
                        stats.dominated_trip_boardings.saturating_add(1);
                }
            }
            if predecessor < 0 {
                continue;
            }
            let trip = segment_trip[connection] as i32;
            if connection > boarding
                && continuity_break[connection] == 0
                && segment_run[connection - 1] as usize == run
                && to_stop[connection - 1] != from_stop[connection]
            {
                let bridge_stop = from_stop[connection] as usize;
                if deadline_allows(stop_deadlines[bridge_stop], connection_departure) {
                    add_round_label(
                        workspace,
                        epoch,
                        destination_workspace,
                        destination_epoch,
                        best,
                        stats,
                        bridge_stop,
                        connection_departure,
                        true,
                        true,
                        true,
                        predecessor,
                        2,
                        trip,
                        sequence[boarding] as f64,
                        sequence[connection - 1] as f64 + 0.5,
                        0,
                        arrival_upper_bound,
                        boarding_upper_bound,
                        transfer_penalty_seconds,
                        walk_reluctance,
                    );
                }
            }
            if can_alight[connection] == 1
                && arrival_seconds[connection] as f64 <= arrival_upper_bound
            {
                let alight_stop = to_stop[connection] as usize;
                if deadline_allows(
                    stop_deadlines[alight_stop],
                    arrival_seconds[connection] as f64,
                ) {
                    add_round_label(
                        workspace,
                        epoch,
                        destination_workspace,
                        destination_epoch,
                        best,
                        stats,
                        alight_stop,
                        arrival_seconds[connection] as f64,
                        true,
                        true,
                        true,
                        predecessor,
                        2,
                        trip,
                        sequence[boarding] as f64,
                        sequence[connection] as f64,
                        0,
                        arrival_upper_bound,
                        boarding_upper_bound,
                        transfer_penalty_seconds,
                        walk_reluctance,
                    );
                }
            }
            if workspace.overflowed {
                return Vec::new();
            }
        }
    }
    let direct_label_end = workspace.labels.len();
    let mut transfer_sources: Vec<usize> = (round_label_start..direct_label_end)
        .filter(|index| workspace.labels[*index].active && workspace.labels[*index].kind == 2)
        .collect();
    transfer_sources.sort_unstable_by(|left, right| {
        workspace.labels[*left]
            .arrival
            .total_cmp(&workspace.labels[*right].arrival)
            .then_with(|| {
                workspace.labels[*left]
                    .walking_seconds
                    .total_cmp(&workspace.labels[*right].walking_seconds)
            })
    });
    for index in transfer_sources {
        let stop = workspace.labels[index].state as usize / STATE_STRIDE;
        expand_round_transfers(
            workspace,
            epoch,
            destination_workspace,
            destination_epoch,
            best,
            stats,
            transfer_offset,
            transfer_edges,
            stop_deadlines,
            stop,
            workspace.labels[index].arrival,
            true,
            index as i32,
            arrival_upper_bound,
            boarding_upper_bound,
            transfer_penalty_seconds,
            walk_reluctance,
        );
        if workspace.overflowed {
            return Vec::new();
        }
    }
    (round_label_start..workspace.labels.len())
        .filter(|index| workspace.labels[*index].active)
        .filter(|index| workspace.labels[*index].boardings == round)
        .map(|index| index as i32)
        .collect()
}

struct ExactDeadlineCorridor {
    stop_deadlines: Vec<Vec<u32>>,
    run_layers: Vec<Vec<u8>>,
    exit_events_scanned: u64,
    run_segments_scanned: u64,
    transfer_edges_scanned: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ParetoRestrictionMode {
    Only,
    Forward,
    Reverse,
    Both,
}

impl ParetoRestrictionMode {
    fn parse(value: Option<&str>) -> napi::Result<Self> {
        match value.unwrap_or("anchor+both") {
            "anchor-only" => Ok(Self::Only),
            "anchor+forward" => Ok(Self::Forward),
            "anchor+reverse" => Ok(Self::Reverse),
            "anchor+both" => Ok(Self::Both),
            other => Err(Error::from_reason(format!(
                "Unknown Pareto restriction mode {other:?}; expected anchor-only, anchor+forward, anchor+reverse, or anchor+both."
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Only => "anchor-only",
            Self::Forward => "anchor+forward",
            Self::Reverse => "anchor+reverse",
            Self::Both => "anchor+both",
        }
    }

    fn uses_forward(self) -> bool {
        matches!(self, Self::Forward | Self::Both)
    }

    fn uses_reverse(self) -> bool {
        matches!(self, Self::Reverse | Self::Both)
    }
}

#[derive(Clone, Copy, Default)]
struct CorridorStructureStats {
    retained_run_layer_memberships: u64,
    total_run_layer_memberships: u64,
    retained_segment_layer_memberships: u64,
    total_segment_layer_memberships: u64,
    retained_stop_deadline_memberships: u64,
    total_stop_deadline_memberships: u64,
    retained_unique_runs: u32,
    restriction_bytes: usize,
}

fn build_open_deadline_corridor(
    stop_count: usize,
    run_count: usize,
    boarding_upper_bound: usize,
    apply_forward_filter: bool,
    forward_run_layers: Option<&[Vec<u8>]>,
    forward_universal_runs: &[u64],
) -> ExactDeadlineCorridor {
    let stop_deadlines = (0..=boarding_upper_bound)
        .map(|_| vec![u32::MAX; stop_count])
        .collect();
    let mut run_layers = Vec::with_capacity(boarding_upper_bound);
    for remaining in 0..boarding_upper_bound {
        if !apply_forward_filter {
            run_layers.push(vec![1; run_count]);
            continue;
        }
        let forward_round = boarding_upper_bound - remaining - 1;
        let forward_runs = forward_run_layers.map(|layers| &layers[forward_round]);
        run_layers.push(
            (0..run_count)
                .map(|run| {
                    u8::from(
                        has_run_bit(forward_universal_runs, run)
                            || forward_runs.is_some_and(|runs| runs[run] != 0),
                    )
                })
                .collect(),
        );
    }
    ExactDeadlineCorridor {
        stop_deadlines,
        run_layers,
        exit_events_scanned: 0,
        run_segments_scanned: 0,
        transfer_edges_scanned: 0,
    }
}

fn corridor_structure_stats(
    corridor: &ExactDeadlineCorridor,
    run_start: &[u32],
    run_end: &[u32],
) -> CorridorStructureStats {
    let run_count = run_start.len();
    let boarding_upper_bound = corridor.run_layers.len();
    let stop_count = corridor.stop_deadlines.first().map_or(0, Vec::len);
    let segment_count = run_start
        .iter()
        .zip(run_end)
        .map(|(start, end)| u64::from(end.saturating_sub(*start)))
        .sum::<u64>();
    let mut retained_runs = vec![false; run_count];
    let mut retained_run_layer_memberships = 0_u64;
    let mut retained_segment_layer_memberships = 0_u64;
    for layer in &corridor.run_layers {
        for (run, retained) in layer.iter().enumerate() {
            if *retained == 0 {
                continue;
            }
            retained_runs[run] = true;
            retained_run_layer_memberships += 1;
            retained_segment_layer_memberships +=
                u64::from(run_end[run].saturating_sub(run_start[run]));
        }
    }
    CorridorStructureStats {
        retained_run_layer_memberships,
        total_run_layer_memberships: (run_count as u64) * (boarding_upper_bound as u64),
        retained_segment_layer_memberships,
        total_segment_layer_memberships: segment_count * (boarding_upper_bound as u64),
        retained_stop_deadline_memberships: corridor
            .stop_deadlines
            .iter()
            .map(|layer| layer.iter().filter(|deadline| **deadline != 0).count() as u64)
            .sum(),
        total_stop_deadline_memberships: (stop_count as u64)
            * (corridor.stop_deadlines.len() as u64),
        retained_unique_runs: retained_runs.iter().filter(|retained| **retained).count() as u32,
        restriction_bytes: corridor
            .stop_deadlines
            .iter()
            .map(|layer| layer.len() * std::mem::size_of::<u32>())
            .sum::<usize>()
            + corridor
                .run_layers
                .iter()
                .map(|layer| layer.len() * std::mem::size_of::<u8>())
                .sum::<usize>(),
    }
}

#[derive(Clone, Copy, Default)]
struct ForwardRunEnvelope {
    departure_events_scanned: u64,
    run_segments_scanned: u64,
    transfer_edges_scanned: u64,
}

struct ForwardWorkspace {
    run_layers: Vec<Vec<u8>>,
    changed_stops: Vec<usize>,
    layer_earliest: Vec<u32>,
    layer_ride_earliest: Vec<u32>,
    stop_layer_mask: Vec<u32>,
    run_layer_mask: Vec<u32>,
    scalar_runs: Vec<u64>,
    scalar_identity: Option<ScalarEnvelopeIdentity>,
}

struct ScalarEnvelopeIdentity {
    origin_stops: Vec<u32>,
    origin_walk_seconds: Vec<f64>,
    destination_stops: Vec<u32>,
    destination_walk_seconds: Vec<f64>,
    departure: u64,
    horizon: u64,
    best_arrival: u64,
    next_scan_time_index: usize,
    best_boardings: u16,
    allow_pre_ride_transfers: bool,
    allow_post_ride_transfers: bool,
}

impl ScalarEnvelopeIdentity {
    fn new(input: &TimetableQueryInput, best: &BestState, next_scan_time_index: usize) -> Self {
        Self {
            origin_stops: input.origin_stops.clone(),
            origin_walk_seconds: input.origin_walk_seconds.clone(),
            destination_stops: input.destination_stops.clone(),
            destination_walk_seconds: input.destination_walk_seconds.clone(),
            departure: input.departure.to_bits(),
            horizon: input.horizon.to_bits(),
            best_arrival: best.arrival.to_bits(),
            next_scan_time_index,
            best_boardings: best.boardings,
            allow_pre_ride_transfers: input.allow_pre_ride_transfers,
            allow_post_ride_transfers: input.allow_post_ride_transfers.unwrap_or(true),
        }
    }

    fn matches(&self, input: &TimetableParetoQueryInput) -> bool {
        self.origin_stops == input.origin_stops
            && self.origin_walk_seconds == input.origin_walk_seconds
            && self.destination_stops == input.destination_stops
            && self.destination_walk_seconds == input.destination_walk_seconds
            && self.departure == input.departure.to_bits()
            && self.horizon == input.horizon.to_bits()
            && self.best_arrival == input.earliest_arrival.to_bits()
            && u32::from(self.best_boardings) == input.boarding_upper_bound
            && self.allow_pre_ride_transfers == input.allow_pre_ride_transfers
            && self.allow_post_ride_transfers == input.allow_post_ride_transfers.unwrap_or(true)
    }

    fn byte_length(&self) -> usize {
        self.origin_stops.capacity() * std::mem::size_of::<u32>()
            + self.origin_walk_seconds.capacity() * std::mem::size_of::<f64>()
            + self.destination_stops.capacity() * std::mem::size_of::<u32>()
            + self.destination_walk_seconds.capacity() * std::mem::size_of::<f64>()
    }
}

impl ForwardWorkspace {
    fn new(stop_count: usize, run_count: usize) -> Self {
        Self {
            run_layers: (0..MAX_PROFILE_BOARDINGS)
                .map(|_| vec![0; run_count])
                .collect(),
            changed_stops: Vec::new(),
            layer_earliest: vec![u32::MAX; (MAX_PROFILE_BOARDINGS + 1) * stop_count],
            layer_ride_earliest: vec![u32::MAX; (MAX_PROFILE_BOARDINGS + 1) * stop_count],
            stop_layer_mask: vec![0; stop_count],
            run_layer_mask: vec![0; run_count],
            scalar_runs: vec![0; run_count.div_ceil(u64::BITS as usize)],
            scalar_identity: None,
        }
    }

    fn byte_length(&self) -> usize {
        self.run_layers
            .iter()
            .map(|layer| layer.len() * std::mem::size_of::<u8>())
            .sum::<usize>()
            + self.changed_stops.capacity() * std::mem::size_of::<usize>()
            + self.layer_earliest.len() * std::mem::size_of::<u32>()
            + self.layer_ride_earliest.len() * std::mem::size_of::<u32>()
            + self.stop_layer_mask.len() * std::mem::size_of::<u32>()
            + self.run_layer_mask.len() * std::mem::size_of::<u32>()
            + self.scalar_runs.len() * std::mem::size_of::<u64>()
            + self
                .scalar_identity
                .as_ref()
                .map_or(0, ScalarEnvelopeIdentity::byte_length)
    }
}

#[inline(always)]
fn set_run_bit(run_bits: &mut [u64], run: usize) {
    run_bits[run >> 6] |= 1_u64 << (run & 63);
}

#[inline(always)]
fn has_run_bit(run_bits: &[u64], run: usize) -> bool {
    run_bits[run >> 6] & (1_u64 << (run & 63)) != 0
}

fn encoded_deadline(value: f64) -> u32 {
    if !value.is_finite() || value < 0.0 {
        return 0;
    }
    value.ceil().min(f64::from(u32::MAX - 1)) as u32 + 1
}

fn destination_deadline_for_boarding_floor(
    arrival_upper_bound: f64,
    generalized_upper_bound: f64,
    destination_walk_seconds: f64,
    boarding_floor: usize,
    transfer_penalty_seconds: f64,
    walk_reluctance: f64,
) -> u32 {
    let arrival_deadline = arrival_upper_bound - destination_walk_seconds;
    let objective_deadline = generalized_upper_bound
        - boarding_floor.saturating_sub(1) as f64 * transfer_penalty_seconds
        - destination_walk_seconds * (1.0 + walk_reluctance);
    encoded_deadline(arrival_deadline.min(objective_deadline))
}

fn deadline_allows(deadline: u32, time: f64) -> bool {
    deadline != 0 && time <= f64::from(deadline - 1)
}

#[inline(always)]
fn offer_forward_layer(
    earliest: &mut [u32],
    stop_layer_mask: &mut [u32],
    stop_count: usize,
    layer: usize,
    stop: usize,
    time: u32,
    maximum_time: u32,
) -> bool {
    if time > maximum_time {
        return false;
    }
    let index = layer * stop_count + stop;
    if time >= earliest[index] {
        return false;
    }
    earliest[index] = time;
    stop_layer_mask[stop] |= 1 << layer;
    true
}

#[allow(clippy::too_many_arguments)]
fn expand_forward_transfer_layer(
    earliest: &mut [u32],
    stop_layer_mask: &mut [u32],
    stop_count: usize,
    layer: usize,
    source: usize,
    source_time: u32,
    maximum_time: u32,
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
) -> u64 {
    let start = transfer_offset[source] as usize;
    let end = transfer_offset[source + 1] as usize;
    for edge in &transfer_edges[start..end] {
        offer_forward_layer(
            earliest,
            stop_layer_mask,
            stop_count,
            layer,
            edge.stop(),
            source_time.saturating_add(edge.duration()),
            maximum_time,
        );
    }
    (end - start) as u64
}

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn offer_forward_ride_exit(
    workspace: &mut ForwardWorkspace,
    stop_count: usize,
    layer: usize,
    stop: usize,
    arrival: u32,
    maximum_time: u32,
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
) -> u64 {
    offer_forward_layer(
        &mut workspace.layer_earliest,
        &mut workspace.stop_layer_mask,
        stop_count,
        layer,
        stop,
        arrival,
        maximum_time,
    );
    let index = layer * stop_count + stop;
    // An earlier walking arrival has already consumed its transfer edge. It
    // cannot suppress a later ride exit that can still take an ingress edge.
    if arrival > maximum_time || arrival >= workspace.layer_ride_earliest[index] {
        return 0;
    }
    workspace.layer_ride_earliest[index] = arrival;
    expand_forward_transfer_layer(
        &mut workspace.layer_earliest,
        &mut workspace.stop_layer_mask,
        stop_count,
        layer,
        stop,
        arrival,
        maximum_time,
        transfer_offset,
        transfer_edges,
    )
}

#[allow(clippy::too_many_arguments)]
fn begin_forward_run_envelope_csa(
    workspace: &mut ForwardWorkspace,
    stop_count: usize,
    run_count: usize,
    boarding_upper_bound: usize,
    origin_stops: &[u32],
    origin_walk_seconds: &[f64],
    departure: f64,
    maximum_time: u32,
    allow_pre_ride_transfers: bool,
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
) -> ForwardRunEnvelope {
    debug_assert_eq!(
        workspace.layer_earliest.len(),
        (MAX_PROFILE_BOARDINGS + 1) * stop_count
    );
    debug_assert_eq!(workspace.run_layer_mask.len(), run_count);
    workspace.layer_earliest.fill(u32::MAX);
    workspace.layer_ride_earliest.fill(u32::MAX);
    workspace.stop_layer_mask.fill(0);
    workspace.run_layer_mask.fill(0);
    workspace.changed_stops.clear();
    for layer in workspace.run_layers.iter_mut().take(boarding_upper_bound) {
        layer.fill(0);
    }
    for index in 0..origin_stops.len() {
        let stop = origin_stops[index] as usize;
        let first_seed = workspace.stop_layer_mask[stop] == 0;
        let time = (departure + origin_walk_seconds[index]).floor().max(0.0) as u32;
        if offer_forward_layer(
            &mut workspace.layer_earliest,
            &mut workspace.stop_layer_mask,
            stop_count,
            0,
            stop,
            time,
            maximum_time,
        ) && first_seed
        {
            workspace.changed_stops.push(stop);
        }
    }
    let mut stats = ForwardRunEnvelope::default();
    if allow_pre_ride_transfers {
        let direct_origin_count = workspace.changed_stops.len();
        for index in 0..direct_origin_count {
            let source = workspace.changed_stops[index];
            let source_time = workspace.layer_earliest[source];
            stats.transfer_edges_scanned =
                stats
                    .transfer_edges_scanned
                    .saturating_add(expand_forward_transfer_layer(
                        &mut workspace.layer_earliest,
                        &mut workspace.stop_layer_mask,
                        stop_count,
                        0,
                        source,
                        source_time,
                        maximum_time,
                        transfer_offset,
                        transfer_edges,
                    ));
        }
    }
    stats
}

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn scan_forward_run_envelope_connection(
    workspace: &mut ForwardWorkspace,
    stop_count: usize,
    boarding_upper_bound: usize,
    event: ScanEvent,
    departure: u32,
    arrival: ScanArrival,
    maximum_time: u32,
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
    stats: &mut ForwardRunEnvelope,
) {
    stats.departure_events_scanned += 1;
    let flags = event.flags();
    let from_stop = event.source_stop();
    let run = event.run();
    if flags & SCAN_CAN_BOARD != 0 {
        let stop_layer_mask = if boarding_upper_bound == u32::BITS as usize {
            u32::MAX
        } else {
            (1_u32 << boarding_upper_bound) - 1
        };
        let mut reachable = workspace.stop_layer_mask[from_stop] & stop_layer_mask;
        while reachable != 0 {
            let layer = reachable.trailing_zeros() as usize;
            reachable &= reachable - 1;
            if workspace.layer_earliest[layer * stop_count + from_stop] > departure {
                continue;
            }
            let bit = 1_u32 << layer;
            if workspace.run_layer_mask[run] & bit == 0 {
                workspace.run_layer_mask[run] |= bit;
                workspace.run_layers[layer][run] = 1;
            }
        }
    }
    let run_layer_mask = if boarding_upper_bound == u32::BITS as usize {
        u32::MAX
    } else {
        (1_u32 << boarding_upper_bound) - 1
    };
    let mut active = workspace.run_layer_mask[run] & run_layer_mask;
    if active == 0 {
        return;
    }
    stats.run_segments_scanned += 1;
    while active != 0 {
        let prior_layer = active.trailing_zeros() as usize;
        active &= active - 1;
        let layer = prior_layer + 1;
        if flags & SCAN_BRIDGE_EXIT != 0 {
            stats.transfer_edges_scanned =
                stats
                    .transfer_edges_scanned
                    .saturating_add(offer_forward_ride_exit(
                        workspace,
                        stop_count,
                        layer,
                        from_stop,
                        departure,
                        maximum_time,
                        transfer_offset,
                        transfer_edges,
                    ));
        }
        if flags & SCAN_CAN_ALIGHT != 0 {
            stats.transfer_edges_scanned =
                stats
                    .transfer_edges_scanned
                    .saturating_add(offer_forward_ride_exit(
                        workspace,
                        stop_count,
                        layer,
                        arrival.to as usize,
                        arrival.arrival,
                        maximum_time,
                        transfer_offset,
                        transfer_edges,
                    ));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_forward_run_envelope_csa(
    workspace: &mut ForwardWorkspace,
    stop_count: usize,
    run_count: usize,
    boarding_upper_bound: usize,
    origin_stops: &[u32],
    origin_walk_seconds: &[f64],
    departure: f64,
    arrival_upper_bound: f64,
    allow_pre_ride_transfers: bool,
    scan_events: &[ScanEvent],
    scan_times: &[u32],
    scan_time_offsets: &[u32],
    scan_arrivals: &[ScanArrival],
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
) -> ForwardRunEnvelope {
    let maximum_time = arrival_upper_bound.ceil().max(0.0) as u32;
    let mut stats = begin_forward_run_envelope_csa(
        workspace,
        stop_count,
        run_count,
        boarding_upper_bound,
        origin_stops,
        origin_walk_seconds,
        departure,
        maximum_time,
        allow_pre_ride_transfers,
        transfer_offset,
        transfer_edges,
    );
    let mut time_index = scan_time_lower_bound(scan_times, departure);
    while time_index < scan_times.len() {
        let scan_departure = scan_times[time_index];
        if scan_departure > maximum_time {
            break;
        }
        let start = scan_time_offsets[time_index] as usize;
        let end = scan_time_offsets[time_index + 1] as usize;
        for cursor in start..end {
            scan_forward_run_envelope_connection(
                workspace,
                stop_count,
                boarding_upper_bound,
                scan_events[cursor],
                scan_departure,
                scan_arrivals[cursor],
                maximum_time,
                transfer_offset,
                transfer_edges,
                &mut stats,
            );
        }
        time_index += 1;
    }
    stats
}

fn exit_event_upper_bound(
    events: &[ExitEvent],
    mut low: usize,
    mut high: usize,
    encoded_stop_deadline: u32,
) -> usize {
    while low < high {
        let middle = (low + high) >> 1;
        if events[middle].time() < encoded_stop_deadline {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

fn exit_event_lower_bound(
    events: &[ExitEvent],
    mut low: usize,
    mut high: usize,
    minimum_time: u32,
) -> usize {
    while low < high {
        let middle = (low + high) >> 1;
        if events[middle].time() < minimum_time {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

fn expand_reverse_transfers_once(
    deadlines: &mut [u32],
    stops: &mut Vec<usize>,
    seeds: &[(usize, u32)],
    reverse_transfer_offset: &[u32],
    reverse_transfer_edges: &[TransferEdge],
    minimum_time: u32,
) -> u64 {
    let mut scanned = 0_u64;
    for &(target, target_deadline) in seeds {
        let start = reverse_transfer_offset[target] as usize;
        let end = reverse_transfer_offset[target + 1] as usize;
        scanned = scanned.saturating_add((end - start) as u64);
        for edge in &reverse_transfer_edges[start..end] {
            let source = edge.stop();
            let source_deadline = target_deadline.saturating_sub(edge.duration());
            if source_deadline <= minimum_time {
                continue;
            }
            if source_deadline <= deadlines[source] {
                continue;
            }
            if deadlines[source] == 0 {
                stops.push(source);
            }
            deadlines[source] = source_deadline;
        }
    }
    scanned
}

#[allow(clippy::too_many_arguments)]
fn build_exact_deadline_corridor(
    stop_count: usize,
    run_count: usize,
    boarding_upper_bound: usize,
    apply_forward_filter: bool,
    forward_run_layers: Option<&[Vec<u8>]>,
    forward_universal_runs: &[u64],
    destination_stops: &[u32],
    destination_walk_seconds: &[f64],
    departure_seconds: &[u32],
    from_stop: &[u32],
    can_board: &[u8],
    run_start: &[u32],
    reverse_transfer_offset: &[u32],
    reverse_transfer_edges: &[TransferEdge],
    exit_event_offset: &[u32],
    exit_events: &[ExitEvent],
    departure_lower_bound: f64,
    arrival_upper_bound: f64,
    generalized_upper_bound: f64,
    transfer_penalty_seconds: f64,
    walk_reluctance: f64,
) -> ExactDeadlineCorridor {
    let minimum_time = departure_lower_bound.floor().max(0.0) as u32;
    let mut initial_deadlines = vec![0_u32; stop_count];
    let mut initial_stops = Vec::new();
    for index in 0..destination_stops.len() {
        let stop = destination_stops[index] as usize;
        let deadline = destination_deadline_for_boarding_floor(
            arrival_upper_bound,
            generalized_upper_bound,
            destination_walk_seconds[index],
            boarding_upper_bound,
            transfer_penalty_seconds,
            walk_reluctance,
        );
        if deadline <= initial_deadlines[stop] {
            continue;
        }
        if initial_deadlines[stop] == 0 {
            initial_stops.push(stop);
        }
        initial_deadlines[stop] = deadline;
    }
    let initial_transfer_seeds = initial_stops
        .iter()
        .map(|stop| (*stop, initial_deadlines[*stop]))
        .collect::<Vec<_>>();
    let mut transfer_edges_scanned = expand_reverse_transfers_once(
        &mut initial_deadlines,
        &mut initial_stops,
        &initial_transfer_seeds,
        reverse_transfer_offset,
        reverse_transfer_edges,
        minimum_time,
    );
    let mut exit_events_scanned = 0_u64;
    let mut run_segments_scanned = 0_u64;

    let mut stop_deadlines = vec![initial_deadlines];
    let mut stop_lists = vec![initial_stops];
    let mut run_layers: Vec<Vec<u8>> = Vec::with_capacity(boarding_upper_bound);
    // A universal forward envelope is identical at every boarding round. Its
    // reverse corridor grows monotonically: process only newly admitted exits
    // and run segments, carrying the previous feasible-run mask forward.
    // Per-round forward envelopes can change eligibility, so retain a fresh
    // reverse scan for that case.
    let incremental = forward_run_layers.is_none();
    let mut run_through = vec![0_u32; run_count];
    let mut processed_through = vec![0_u32; run_count];
    let mut transfer_seed_deadlines = vec![0_u32; stop_count];
    for remaining in 0..boarding_upper_bound {
        let forward_round = boarding_upper_bound - remaining - 1;
        let forward_runs = forward_run_layers.map(|layers| &layers[forward_round]);
        let layer_minimum_time = minimum_time;
        let target_deadlines = &stop_deadlines[remaining];
        let mut run_mask = if incremental && remaining > 0 {
            run_layers[remaining - 1].clone()
        } else {
            vec![0_u8; run_count]
        };
        if !incremental {
            run_through.fill(0);
            processed_through.fill(0);
        }
        let mut touched_runs = Vec::new();
        for stop in &stop_lists[remaining] {
            let previous_deadline = if incremental && remaining > 0 {
                stop_deadlines[remaining - 1][*stop]
            } else {
                0
            };
            if target_deadlines[*stop] <= previous_deadline {
                continue;
            }
            let offset_start = exit_event_offset[*stop] as usize;
            let offset_end = exit_event_offset[*stop + 1] as usize;
            let start = exit_event_lower_bound(
                exit_events,
                offset_start,
                offset_end,
                layer_minimum_time.max(previous_deadline),
            );
            let end =
                exit_event_upper_bound(exit_events, start, offset_end, target_deadlines[*stop]);
            exit_events_scanned = exit_events_scanned.saturating_add((end - start) as u64);
            for event in &exit_events[start..end] {
                let run = event.run();
                if apply_forward_filter
                    && !has_run_bit(forward_universal_runs, run)
                    && forward_runs.is_none_or(|runs| runs[run] == 0)
                {
                    continue;
                }
                let through = event.through_segment(run_start) + 1;
                if through > run_through[run] {
                    if run_through[run] == processed_through[run] {
                        touched_runs.push(run);
                    }
                    run_through[run] = through;
                }
            }
        }

        let mut next_deadlines = target_deadlines.clone();
        let mut next_stops = stop_lists[remaining].clone();
        let mut transfer_seed_stops = Vec::new();
        transfer_seed_deadlines.fill(0);
        for run in touched_runs {
            let start = run_start[run].max(processed_through[run]) as usize;
            let end = run_through[run] as usize;
            run_segments_scanned = run_segments_scanned.saturating_add((end - start) as u64);
            let mut boardable = run_mask[run] != 0;
            for segment in (start..end).rev() {
                if departure_seconds[segment] < layer_minimum_time {
                    break;
                }
                if can_board[segment] == 1 {
                    boardable = true;
                    let stop = from_stop[segment] as usize;
                    let deadline = departure_seconds[segment].saturating_add(1);
                    // Keep the run-specific episode boundary even when a carried
                    // deadline is later; only this boundary permits one ingress edge.
                    if transfer_seed_deadlines[stop] == 0 {
                        transfer_seed_stops.push(stop);
                    }
                    transfer_seed_deadlines[stop] = transfer_seed_deadlines[stop].max(deadline);
                    if deadline > next_deadlines[stop] {
                        if next_deadlines[stop] == 0 {
                            next_stops.push(stop);
                        }
                        next_deadlines[stop] = deadline;
                    }
                }
            }
            run_mask[run] = u8::from(boardable);
            processed_through[run] = run_through[run];
        }
        let next_boarding_floor = boarding_upper_bound - remaining - 1;
        for index in 0..destination_stops.len() {
            let stop = destination_stops[index] as usize;
            let deadline = destination_deadline_for_boarding_floor(
                arrival_upper_bound,
                generalized_upper_bound,
                destination_walk_seconds[index],
                next_boarding_floor,
                transfer_penalty_seconds,
                walk_reluctance,
            );
            if deadline != 0 {
                if transfer_seed_deadlines[stop] == 0 {
                    transfer_seed_stops.push(stop);
                }
                transfer_seed_deadlines[stop] = transfer_seed_deadlines[stop].max(deadline);
            }
            if deadline <= next_deadlines[stop] {
                continue;
            }
            if next_deadlines[stop] == 0 {
                next_stops.push(stop);
            }
            next_deadlines[stop] = deadline;
        }
        transfer_seed_stops.sort_unstable();
        let transfer_seeds = transfer_seed_stops
            .into_iter()
            .map(|stop| (stop, transfer_seed_deadlines[stop]))
            .collect::<Vec<_>>();
        transfer_edges_scanned =
            transfer_edges_scanned.saturating_add(expand_reverse_transfers_once(
                &mut next_deadlines,
                &mut next_stops,
                &transfer_seeds,
                reverse_transfer_offset,
                reverse_transfer_edges,
                minimum_time,
            ));
        run_layers.push(run_mask);
        stop_deadlines.push(next_deadlines);
        stop_lists.push(next_stops);
    }
    ExactDeadlineCorridor {
        stop_deadlines,
        run_layers,
        exit_events_scanned,
        run_segments_scanned,
        transfer_edges_scanned,
    }
}

fn boarding_ready_time(
    arrival: f64,
    has_ride: bool,
    transfer_episode_state: bool,
    minimum: u32,
) -> f64 {
    arrival
        + if has_ride && transfer_episode_state {
            f64::from(minimum)
        } else {
            0.0
        }
}

#[napi]
pub struct TimetableKernel {
    stop_count: usize,
    run_count: usize,
    departure_seconds: Uint32Array,
    arrival_seconds: Uint32Array,
    from_stop: Uint32Array,
    to_stop: Uint32Array,
    sequence: Uint32Array,
    segment_trip: Uint32Array,
    segment_run: Uint32Array,
    continuity_break: Uint8Array,
    can_board: Uint8Array,
    can_alight: Uint8Array,
    trip_start: Uint32Array,
    // These offsets index native-owned compact event arrays, so keep them in
    // the same immutable ownership domain instead of retaining JS views.
    departure_offset: Vec<u32>,
    departure_events: Vec<DepartureEvent>,
    transfer_offset: Vec<u32>,
    transfer_edges: Vec<TransferEdge>,
    forbidden_same_stop: Uint8Array,
    same_stop_transfer_minimum: Vec<u32>,
    scan_events: Vec<ScanEvent>,
    scan_times: Vec<u32>,
    scan_time_offsets: Vec<u32>,
    scan_time_needs_closure: Vec<bool>,
    scan_arrivals: Vec<ScanArrival>,
    scan_journeys: Vec<ScanJourney>,
    run_start: Vec<u32>,
    run_end: Vec<u32>,
    reverse_transfer_offset: Vec<u32>,
    reverse_transfer_edges: Vec<TransferEdge>,
    exit_event_offset: Vec<u32>,
    exit_events: Vec<ExitEvent>,
    workspace: ScalarWorkspace,
    many_workspace: ManyWorkspace,
    forward_workspace: ForwardWorkspace,
    profile_workspace: ProfileWorkspace,
}

#[napi]
impl TimetableKernel {
    #[napi(constructor)]
    pub fn new(input: TimetableKernelInput) -> napi::Result<Self> {
        let stop_count = input.stop_count as usize;
        let run_count = input.run_count as usize;
        let segment_count = input.departure_seconds.len();
        let trip_count = input.trip_start.len().saturating_sub(1);
        if !crate::timetable_validation::kernel_input_is_valid(
            &input,
            SCAN_RUN_MASK,
            EXIT_TIME_MASK,
        ) {
            return Err(Error::from_reason(
                "Rust timetable kernel arrays are inconsistent.",
            ));
        }
        let mut connection_order: Vec<u32> = (0..segment_count as u32).collect();
        connection_order.sort_unstable_by(|left, right| {
            input.departure_seconds[*left as usize]
                .cmp(&input.departure_seconds[*right as usize])
                .then_with(|| left.cmp(right))
        });
        let mut scan_events = Vec::with_capacity(segment_count);
        let mut scan_times = Vec::new();
        let mut scan_time_offsets = Vec::new();
        let mut scan_time_needs_closure = Vec::new();
        let mut scan_arrivals = Vec::with_capacity(segment_count);
        let mut scan_journeys = Vec::with_capacity(segment_count);
        let mut prior_departure = None;
        for segment in connection_order {
            let index = segment as usize;
            let departure = input.departure_seconds[index];
            if prior_departure != Some(departure) {
                scan_times.push(departure);
                scan_time_offsets.push(scan_events.len() as u32);
                scan_time_needs_closure.push(false);
                prior_departure = Some(departure);
            }
            let bridge_exit = index > 0
                && input.continuity_break[index] == 0
                && input.segment_run[index - 1] == input.segment_run[index]
                && input.to_stop[index - 1] != input.from_stop[index];
            // Only zero-time arrivals and bridge exits can introduce another
            // boarding at this timestamp. This exact dependency flag avoids
            // revisiting buckets that cannot contain such a dependency.
            if input.arrival_seconds[index] == departure || bridge_exit {
                *scan_time_needs_closure.last_mut().unwrap() = true;
            }
            let flags = (if input.can_board[index] == 1 {
                SCAN_CAN_BOARD
            } else {
                0
            }) | (if input.can_alight[index] == 1 {
                SCAN_CAN_ALIGHT
            } else {
                0
            }) | (if bridge_exit { SCAN_BRIDGE_EXIT } else { 0 });
            let run_flags = input.segment_run[index] | u32::from(flags) << 29;
            scan_events.push(ScanEvent(
                u64::from(input.from_stop[index]) | u64::from(run_flags) << 32,
            ));
            scan_arrivals.push(ScanArrival {
                arrival: input.arrival_seconds[index],
                to: input.to_stop[index],
            });
            scan_journeys.push(ScanJourney {
                trip: input.segment_trip[index],
                sequence: input.sequence[index],
                prior_sequence: if index > 0 {
                    input.sequence[index - 1]
                } else {
                    0
                },
            });
        }
        scan_time_offsets.push(scan_events.len() as u32);
        let departure_events = input
            .departure_order
            .iter()
            .map(|segment| {
                let index = *segment as usize;
                DepartureEvent {
                    departure: input.departure_seconds[index],
                    run: input.segment_run[index],
                }
            })
            .collect();
        let transfer_edges = input
            .transfer_to
            .iter()
            .zip(input.transfer_duration.iter())
            .map(|(target, duration)| TransferEdge::new(*target, *duration))
            .collect();
        let mut run_start = vec![u32::MAX; run_count];
        let mut run_end = vec![0; run_count];
        for segment in 0..segment_count {
            let run = input.segment_run[segment] as usize;
            run_start[run] = run_start[run].min(segment as u32);
            run_end[run] = segment as u32 + 1;
        }
        if run_start.contains(&u32::MAX) {
            return Err(Error::from_reason(
                "Rust timetable kernel contains an empty run.",
            ));
        }
        if (0..run_count).any(|run| {
            run_end[run]
                .saturating_sub(run_start[run])
                .saturating_sub(1)
                > EXIT_RELATIVE_SEGMENT_MASK
        }) {
            return Err(Error::from_reason(
                "Rust timetable kernel contains a run with too many segments.",
            ));
        }
        let mut reverse_transfer_counts = vec![0_u32; stop_count];
        for target in input.transfer_to.iter() {
            reverse_transfer_counts[*target as usize] += 1;
        }
        let mut reverse_transfer_offset = vec![0_u32; stop_count + 1];
        for stop in 0..stop_count {
            reverse_transfer_offset[stop + 1] =
                reverse_transfer_offset[stop] + reverse_transfer_counts[stop];
        }
        let mut reverse_transfer_cursor = reverse_transfer_offset[..stop_count].to_vec();
        let mut reverse_transfer_edges = vec![TransferEdge(0); input.transfer_to.len()];
        for source in 0..stop_count {
            for edge in
                input.transfer_offset[source] as usize..input.transfer_offset[source + 1] as usize
            {
                let target = input.transfer_to[edge] as usize;
                let index = reverse_transfer_cursor[target] as usize;
                reverse_transfer_edges[index] =
                    TransferEdge::new(source as u32, input.transfer_duration[edge]);
                reverse_transfer_cursor[target] += 1;
            }
        }
        let mut exit_records = Vec::<(u32, ExitEvent)>::new();
        for segment in 0..segment_count {
            let run = input.segment_run[segment];
            if input.can_alight[segment] == 1 {
                exit_records.push((
                    input.to_stop[segment],
                    ExitEvent::new(
                        input.arrival_seconds[segment],
                        run,
                        segment as u32,
                        run_start[run as usize],
                    ),
                ));
            }
            let run_index = run as usize;
            let bridge_exit = segment > run_start[run_index] as usize
                && input.continuity_break[segment] == 0
                && input.segment_run[segment - 1] == run
                && input.to_stop[segment - 1] != input.from_stop[segment];
            if bridge_exit {
                exit_records.push((
                    input.from_stop[segment],
                    ExitEvent::new(
                        input.departure_seconds[segment],
                        run,
                        segment as u32 - 1,
                        run_start[run as usize],
                    ),
                ));
            }
        }
        exit_records.sort_unstable_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.time().cmp(&right.1.time()))
                .then_with(|| left.1.run().cmp(&right.1.run()))
                .then_with(|| {
                    left.1
                        .through_segment(&run_start)
                        .cmp(&right.1.through_segment(&run_start))
                })
        });
        exit_records.dedup_by(|left, right| left.0 == right.0 && left.1.0 == right.1.0);
        let mut exit_event_offset = vec![0_u32; stop_count + 1];
        for (stop, _) in &exit_records {
            exit_event_offset[*stop as usize + 1] += 1;
        }
        for stop in 0..stop_count {
            exit_event_offset[stop + 1] += exit_event_offset[stop];
        }
        let exit_events = exit_records.into_iter().map(|(_, event)| event).collect();
        Ok(Self {
            stop_count,
            run_count,
            departure_seconds: input.departure_seconds,
            arrival_seconds: input.arrival_seconds,
            from_stop: input.from_stop,
            to_stop: input.to_stop,
            sequence: input.sequence,
            segment_trip: input.segment_trip,
            segment_run: input.segment_run,
            continuity_break: input.continuity_break,
            can_board: input.can_board,
            can_alight: input.can_alight,
            trip_start: input.trip_start,
            departure_offset: input.departure_offset.to_vec(),
            departure_events,
            transfer_offset: input.transfer_offset.to_vec(),
            transfer_edges,
            forbidden_same_stop: input.forbidden_same_stop,
            same_stop_transfer_minimum: input
                .same_stop_transfer_minimum
                .map_or_else(|| vec![0; stop_count], |values| values.to_vec()),
            scan_events,
            scan_times,
            scan_time_offsets,
            scan_time_needs_closure,
            scan_arrivals,
            scan_journeys,
            run_start,
            run_end,
            reverse_transfer_offset,
            reverse_transfer_edges,
            exit_event_offset,
            exit_events,
            workspace: ScalarWorkspace::new(stop_count, run_count),
            many_workspace: ManyWorkspace::new(stop_count, run_count, trip_count),
            forward_workspace: ForwardWorkspace::new(stop_count, run_count),
            profile_workspace: ProfileWorkspace::new(stop_count * STATE_STRIDE, run_count),
        })
    }

    #[napi]
    pub fn route_scalar_csa(
        &mut self,
        input: TimetableQueryInput,
    ) -> napi::Result<TimetableQueryResult> {
        self.route_scalar_csa_impl(&input, true)
    }

    fn route_scalar_csa_impl(
        &mut self,
        input: &TimetableQueryInput,
        retain_journey: bool,
    ) -> napi::Result<TimetableQueryResult> {
        let started = Instant::now();
        if input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.origin_stops.len() != input.origin_candidate_indices.len()
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input.destination_stops.len() != input.destination_candidate_indices.len()
            || input
                .origin_stops
                .iter()
                .chain(input.destination_stops.iter())
                .any(|stop| *stop as usize >= self.stop_count)
            || input
                .origin_walk_seconds
                .iter()
                .chain(input.destination_walk_seconds.iter())
                .any(|seconds| !seconds.is_finite() || *seconds < 0.0)
            || !input.departure.is_finite()
            || !input.horizon.is_finite()
            || input.departure < 0.0
            || input.horizon < input.departure
        {
            return Err(Error::from_reason(
                "Rust timetable query arrays or bounds are inconsistent.",
            ));
        }

        if let Some(maximum) = input.maximum_boardings {
            boarding_layers(Some(maximum))?;
            self.forward_workspace.scalar_identity = None;
            let unrestricted = self.route_scalar_csa_impl(
                &TimetableQueryInput {
                    maximum_boardings: None,
                    ..input.clone()
                },
                true,
            )?;
            if unrestricted.status == "blocked" {
                return Ok(TimetableQueryResult {
                    query_ns: started.elapsed().as_nanos() as f64,
                    ..unrestricted
                });
            }
            // A feasible unrestricted winner proves the capped arrival too.
            // Its boarding count tightens the exact rounds; no transfer layer
            // above that witnessed count can improve the lexicographic result.
            let (arrival, boarding_bound, initial_query_ns, initial_scanned) = if unrestricted
                .best_boardings
                .is_some_and(|boardings| boardings <= maximum)
                && let Some(arrival) = unrestricted.best_arrival
            {
                (
                    arrival,
                    unrestricted.best_boardings.unwrap(),
                    unrestricted.query_ns,
                    unrestricted.scanned_departures,
                )
            } else {
                let times = self.route_many_csa(TimetableManyQueryInput {
                    origin_stops: input.origin_stops.clone(),
                    origin_walk_seconds: input.origin_walk_seconds.clone(),
                    destination_offsets: vec![0, input.destination_stops.len() as u32],
                    destination_stops: input.destination_stops.clone(),
                    destination_walk_seconds: input.destination_walk_seconds.clone(),
                    excluded_trips: Vec::new(),
                    departure: input.departure,
                    horizon: input.horizon,
                    allow_pre_ride_transfers: input.allow_pre_ride_transfers,
                    allow_post_ride_transfers: Some(vec![
                        input.allow_post_ride_transfers.unwrap_or(true),
                    ]),
                    maximum_boardings: Some(maximum),
                })?;
                (
                    times.best_arrivals[0],
                    maximum,
                    times.query_ns + unrestricted.query_ns,
                    times
                        .scanned_departures
                        .saturating_add(unrestricted.scanned_departures),
                )
            };
            if !arrival.is_finite() {
                let mut result = empty_result(started, true, "no_path_within_transfer_limit");
                result.status = "blocked".to_owned();
                result.scanned_departures = initial_scanned;
                return Ok(result);
            }
            // The shared capped scan supplies a proven feasible arrival. Its
            // worst-case walking bound admits every witness at that arrival;
            // exact rounds recover the least-boardings/least-walking chain.
            let result = self.route_pareto_round_csa(TimetableParetoQueryInput {
                origin_stops: input.origin_stops.clone(),
                origin_walk_seconds: input.origin_walk_seconds.clone(),
                origin_candidate_indices: input.origin_candidate_indices.clone(),
                destination_stops: input.destination_stops.clone(),
                destination_walk_seconds: input.destination_walk_seconds.clone(),
                destination_candidate_indices: input.destination_candidate_indices.clone(),
                departure: input.departure,
                horizon: input.horizon,
                allow_pre_ride_transfers: input.allow_pre_ride_transfers,
                allow_post_ride_transfers: input.allow_post_ride_transfers,
                earliest_arrival: arrival,
                boarding_upper_bound: boarding_bound,
                candidate_destination_index: 0,
                candidate_walking_seconds: f64::MAX,
                arrival_slack_seconds: 0.0,
                transfer_penalty_seconds: 0.0,
                walk_reluctance: 0.0,
                collect_alternatives: None,
                restriction_mode: None,
                deadline_objective: None,
            })?;
            if !result.improved_candidate {
                return Err(Error::from_reason(
                    "Capped timetable arrival has no matching exact journey witness.",
                ));
            }
            return Ok(TimetableQueryResult {
                supported: result.supported,
                status: result.status,
                reason: result.reason,
                best_arrival: result.best_arrival,
                best_boardings: result.best_boardings,
                best_destination_index: result.best_destination_index,
                chain_kinds: result.chain_kinds,
                chain_from_stops: result.chain_from_stops,
                chain_to_stops: result.chain_to_stops,
                chain_trip_or_candidate: result.chain_trip_or_candidate,
                chain_board_sequences: result.chain_board_sequences,
                chain_alight_sequences: result.chain_alight_sequences,
                chain_durations: result.chain_durations,
                chain_arrivals: result.chain_arrivals,
                query_ns: started.elapsed().as_nanos() as f64,
                destination_seed_ns: 0.0,
                origin_seed_ns: 0.0,
                scan_ns: initial_query_ns + result.query_ns,
                chain_ns: 0.0,
                popped_states: 0,
                scanned_departures: initial_scanned.saturating_add(result.scanned_departures),
                relaxed_stops: result.relaxed_stops,
                expanded_trip_runs: result.expanded_trip_runs,
                dominated_trip_boardings: result.dominated_trip_boardings,
                explicit_transfer_checks: result.explicit_transfer_checks,
            });
        }
        let Self {
            stop_count: _,
            run_count: _,
            departure_seconds: _,
            arrival_seconds: _,
            from_stop: _,
            to_stop: _,
            sequence: _,
            segment_trip: _,
            segment_run: _,
            continuity_break: _,
            can_board: _,
            can_alight: _,
            trip_start: _,
            departure_offset,
            departure_events,
            transfer_offset,
            transfer_edges,
            forbidden_same_stop,
            same_stop_transfer_minimum,
            scan_events,
            scan_times,
            scan_time_offsets,
            scan_time_needs_closure,
            scan_arrivals,
            scan_journeys,
            run_start: _,
            run_end: _,
            reverse_transfer_offset: _,
            reverse_transfer_edges: _,
            exit_event_offset: _,
            exit_events: _,
            workspace,
            many_workspace: _,
            forward_workspace,
            profile_workspace: _,
        } = self;
        forward_workspace.scalar_identity = None;
        let epoch = workspace.begin_query();
        workspace.allow_post_ride_transfers = input.allow_post_ride_transfers.unwrap_or(true);
        let destination_seed_started = Instant::now();
        let mut destination_seeds = 0_u32;
        let mut minimum_destination_egress = f64::INFINITY;
        for index in 0..input.destination_stops.len() {
            let stop = input.destination_stops[index] as usize;
            let walk_seconds = input.destination_walk_seconds[index];
            minimum_destination_egress = minimum_destination_egress.min(walk_seconds);
            if workspace.destination_generation[stop] != epoch {
                workspace.destination_generation[stop] = epoch;
                workspace.destination_egress[stop] = walk_seconds;
                workspace.destination_candidate[stop] =
                    input.destination_candidate_indices[index] as i32;
                destination_seeds = destination_seeds.saturating_add(1);
            } else if walk_seconds < workspace.destination_egress[stop] {
                workspace.destination_egress[stop] = walk_seconds;
                workspace.destination_candidate[stop] =
                    input.destination_candidate_indices[index] as i32;
            }
        }
        if destination_seeds == 0 {
            return Ok(empty_result(started, false, "destination_outside_kernel"));
        }
        let destination_seed_ns = destination_seed_started.elapsed().as_nanos() as f64;

        let mut stats = SearchStats::default();
        let mut best = BestState::default();
        let origin_seed_started = Instant::now();
        let mut origin_seeds = 0_u32;
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let arrival = input.departure + input.origin_walk_seconds[index];
            let state = relax_connection_scan(
                workspace,
                epoch,
                &mut best,
                &mut stats,
                stop,
                arrival,
                false,
                false,
                false,
                NO_STATE,
                3,
                input.origin_candidate_indices[index] as i32,
                0.0,
                0.0,
                input.origin_walk_seconds[index].max(0.0).round() as u32,
            );
            if state < 0 {
                continue;
            }
            origin_seeds = origin_seeds.saturating_add(1);
            if input.allow_pre_ride_transfers {
                expand_connection_scan_transfer_edges(
                    workspace,
                    epoch,
                    &mut best,
                    &mut stats,
                    transfer_offset,
                    transfer_edges,
                    stop,
                    arrival,
                    false,
                    state,
                );
            }
        }
        if origin_seeds == 0 {
            return Ok(empty_result(started, false, "origin_outside_kernel"));
        }
        let origin_seed_ns = origin_seed_started.elapsed().as_nanos() as f64;

        let scan_started = Instant::now();
        // With coordinate access, pre-ride transfer expansion is disabled.
        // The first feasible event is therefore the earliest indexed departure
        // at any origin stop after that stop's own access walk completes.
        // Starting there skips only departures that cannot be boarded.
        let scan_start = if input.allow_pre_ride_transfers {
            input.departure
        } else {
            earliest_boardable_departure(
                departure_offset,
                departure_events,
                &input.origin_stops,
                &input.origin_walk_seconds,
                input.departure,
            )
        };
        let mut time_index = scan_time_lower_bound(scan_times, scan_start);
        while time_index < scan_times.len() {
            let connection_departure = scan_times[time_index] as f64;
            // Every remaining journey must spend at least the smallest legal
            // destination-egress time after a departure at this timestamp.
            // A strict bound preserves equal-arrival, fewer-boarding ties.
            if connection_departure > input.horizon
                || connection_departure + minimum_destination_egress > best.arrival
            {
                break;
            }
            let start = scan_time_offsets[time_index] as usize;
            let end = scan_time_offsets[time_index + 1] as usize;
            let bucket_events = &scan_events[start..end];
            let bucket_arrivals = &scan_arrivals[start..end];
            let bucket_journeys = &scan_journeys[start..end];
            loop {
                let previous_changes = (stats.relaxed_stops, stats.expanded_trip_runs);
                stats.scanned_departures += (end - start) as u32;
                for (offset, ((&event, &arrival), &journey)) in bucket_events
                    .iter()
                    .zip(bucket_arrivals)
                    .zip(bucket_journeys)
                    .enumerate()
                {
                    let connection = start + offset;
                    let scan_flags = event.flags();
                    let stop = event.source_stop();
                    let run = event.run();
                    let mut boarding_state = NO_STATE;
                    if scan_flags & SCAN_CAN_BOARD != 0
                        && workspace.active_stop_generation[stop] == epoch
                        && workspace.active_state_mask[stop] != 0
                    {
                        let mut active_states = workspace.active_state_mask[stop];
                        while active_states != 0 {
                            let flags = active_states.trailing_zeros() as usize;
                            active_states &= active_states - 1;
                            let state = stop * STATE_STRIDE + flags;
                            let has_ride = flags & 4 != 0;
                            if has_ride && forbidden_same_stop[stop] == 1 {
                                continue;
                            }
                            let needs_board_slack = flags & 1 != 0;
                            if boarding_ready_time(
                                workspace.labels[state].arrival,
                                has_ride,
                                needs_board_slack,
                                same_stop_transfer_minimum[stop],
                            ) > connection_departure
                            {
                                continue;
                            }
                            if boarding_state < 0 {
                                boarding_state = state as i32;
                                continue;
                            }
                            let retained = boarding_state as usize;
                            if workspace.labels[state].boardings
                                < workspace.labels[retained].boardings
                                || (workspace.labels[state].boardings
                                    == workspace.labels[retained].boardings
                                    && (workspace.labels[state].arrival
                                        < workspace.labels[retained].arrival
                                        || (workspace.labels[state].arrival
                                            == workspace.labels[retained].arrival
                                            && (workspace.labels[state].walking_seconds
                                                < workspace.labels[retained].walking_seconds
                                                || (workspace.labels[state].walking_seconds
                                                    == workspace.labels[retained]
                                                        .walking_seconds
                                                    && state < retained)))))
                            {
                                boarding_state = state as i32;
                            }
                        }
                    }

                    let run_active = workspace.run_generation[run] == epoch;
                    let earlier_start = if run_active {
                        workspace.expanded_run_start[run]
                    } else {
                        NO_STATE
                    };
                    let mut run_updated = false;
                    if boarding_state >= 0 {
                        let candidate_boardings = workspace.labels[boarding_state as usize]
                            .boardings
                            .saturating_add(1);
                        let retained_boardings = if run_active {
                            workspace.labels[workspace.run_predecessor_state[run] as usize]
                                .boardings
                                .saturating_add(1)
                        } else {
                            u16::MAX
                        };
                        if !run_active
                            || candidate_boardings < retained_boardings
                            || (candidate_boardings == retained_boardings
                                && connection < earlier_start as usize)
                        {
                            if !run_active {
                                workspace.run_generation[run] = epoch;
                                workspace.touched_runs.push(run as u32);
                            }
                            workspace.expanded_run_start[run] = connection as i32;
                            workspace.run_predecessor_state[run] = boarding_state;
                            run_updated = true;
                            stats.expanded_trip_runs += 1;
                        } else {
                            stats.dominated_trip_boardings += 1;
                        }
                    }
                    if workspace.run_generation[run] != epoch
                        || workspace.expanded_run_start[run] < 0
                        || workspace.expanded_run_start[run] > connection as i32
                    {
                        continue;
                    }
                    if run_updated {
                        workspace.run_board_sequence[run] = journey.sequence;
                    }
                    let boarding = workspace.expanded_run_start[run] as usize;
                    let predecessor = workspace.run_predecessor_state[run];
                    let board_sequence = workspace.run_board_sequence[run] as f64;
                    let trip = journey.trip as i32;
                    if connection > boarding && scan_flags & SCAN_BRIDGE_EXIT != 0 {
                        let bridge_arrival = connection_departure;
                        if bridge_arrival <= input.horizon && bridge_arrival <= best.arrival {
                            let bridge_stop = event.source_stop();
                            let bridge_state = relax_connection_scan(
                                workspace,
                                epoch,
                                &mut best,
                                &mut stats,
                                bridge_stop,
                                bridge_arrival,
                                true,
                                true,
                                true,
                                predecessor,
                                2,
                                trip,
                                board_sequence,
                                journey.prior_sequence as f64 + 0.5,
                                0,
                            );
                            if bridge_state >= 0 {
                                expand_connection_scan_transfer_edges(
                                    workspace,
                                    epoch,
                                    &mut best,
                                    &mut stats,
                                    transfer_offset,
                                    transfer_edges,
                                    bridge_stop,
                                    bridge_arrival,
                                    true,
                                    bridge_state,
                                );
                            }
                        }
                    }
                    let connection_arrival = arrival.arrival as f64;
                    if scan_flags & SCAN_CAN_ALIGHT == 0
                        || connection_arrival > input.horizon
                        || connection_arrival > best.arrival
                    {
                        continue;
                    }
                    let alight_stop = arrival.to as usize;
                    let alight_state = relax_connection_scan(
                        workspace,
                        epoch,
                        &mut best,
                        &mut stats,
                        alight_stop,
                        connection_arrival,
                        true,
                        true,
                        true,
                        predecessor,
                        2,
                        trip,
                        board_sequence,
                        journey.sequence as f64,
                        0,
                    );
                    if alight_state >= 0 {
                        expand_connection_scan_transfer_edges(
                            workspace,
                            epoch,
                            &mut best,
                            &mut stats,
                            transfer_offset,
                            transfer_edges,
                            alight_stop,
                            connection_arrival,
                            true,
                            alight_state,
                        );
                    }
                }
                if !scan_time_needs_closure[time_index]
                    || previous_changes == (stats.relaxed_stops, stats.expanded_trip_runs)
                {
                    break;
                }
            }
            time_index += 1;
        }
        let scan_ns = scan_started.elapsed().as_nanos() as f64;

        if best.state >= 0 && retain_journey {
            forward_workspace.scalar_runs.fill(0);
            for run in workspace.touched_runs.iter().copied() {
                set_run_bit(&mut forward_workspace.scalar_runs, run as usize);
            }
            forward_workspace.scalar_identity =
                Some(ScalarEnvelopeIdentity::new(input, &best, time_index));
        }
        if best.state < 0 {
            return Ok(TimetableQueryResult {
                supported: true,
                status: "blocked".to_owned(),
                reason: None,
                best_arrival: None,
                best_boardings: None,
                best_destination_index: None,
                chain_kinds: Vec::new(),
                chain_from_stops: Vec::new(),
                chain_to_stops: Vec::new(),
                chain_trip_or_candidate: Vec::new(),
                chain_board_sequences: Vec::new(),
                chain_alight_sequences: Vec::new(),
                chain_durations: Vec::new(),
                chain_arrivals: Vec::new(),
                query_ns: started.elapsed().as_nanos() as f64,
                destination_seed_ns,
                origin_seed_ns,
                scan_ns,
                chain_ns: 0.0,
                popped_states: 0,
                scanned_departures: stats.scanned_departures,
                relaxed_stops: stats.relaxed_stops,
                expanded_trip_runs: stats.expanded_trip_runs,
                dominated_trip_boardings: stats.dominated_trip_boardings,
                explicit_transfer_checks: stats.explicit_transfer_checks,
            });
        }

        let (chain, chain_ns) = if retain_journey {
            let chain_started = Instant::now();
            let mut chain = Vec::<JourneyChainStep>::new();
            let mut state = best.state;
            while state >= 0 {
                let state_index = state as usize;
                let predecessor_record = workspace.predecessors[state_index];
                let kind = predecessor_record.kind;
                let stop = (state_index / STATE_STRIDE) as i32;
                if kind == 3 {
                    chain.push((
                        3,
                        NO_STATE,
                        stop,
                        predecessor_record.trip,
                        0.0,
                        0.0,
                        predecessor_record.duration,
                        workspace.labels[state_index].arrival,
                    ));
                    break;
                }
                let predecessor = predecessor_record.state;
                if predecessor < 0 {
                    break;
                }
                chain.push((
                    kind as u32,
                    (predecessor as usize / STATE_STRIDE) as i32,
                    stop,
                    predecessor_record.trip,
                    f64::from(predecessor_record.board_sequence_twice) * 0.5,
                    f64::from(predecessor_record.alight_sequence_twice) * 0.5,
                    predecessor_record.duration,
                    workspace.labels[state_index].arrival,
                ));
                state = predecessor;
            }
            chain.reverse();
            (chain, chain_started.elapsed().as_nanos() as f64)
        } else {
            (Vec::new(), 0.0)
        };

        Ok(TimetableQueryResult {
            supported: true,
            status: "ready".to_owned(),
            reason: None,
            best_arrival: Some(best.arrival),
            best_boardings: Some(best.boardings as u32),
            best_destination_index: Some(best.destination_index as u32),
            chain_kinds: chain.iter().map(|step| step.0).collect(),
            chain_from_stops: chain.iter().map(|step| step.1).collect(),
            chain_to_stops: chain.iter().map(|step| step.2).collect(),
            chain_trip_or_candidate: chain.iter().map(|step| step.3).collect(),
            chain_board_sequences: chain.iter().map(|step| step.4).collect(),
            chain_alight_sequences: chain.iter().map(|step| step.5).collect(),
            chain_durations: chain.iter().map(|step| step.6).collect(),
            chain_arrivals: chain.iter().map(|step| step.7).collect(),
            query_ns: started.elapsed().as_nanos() as f64,
            destination_seed_ns,
            origin_seed_ns,
            scan_ns,
            chain_ns,
            popped_states: 0,
            scanned_departures: stats.scanned_departures,
            relaxed_stops: stats.relaxed_stops,
            expanded_trip_runs: stats.expanded_trip_runs,
            dominated_trip_boardings: stats.dominated_trip_boardings,
            explicit_transfer_checks: stats.explicit_transfer_checks,
        })
    }

    #[napi]
    pub fn route_arrive_by_csa(
        &mut self,
        input: TimetableArriveByQueryInput,
    ) -> napi::Result<TimetableArriveByQueryResult> {
        let started = Instant::now();
        if input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.origin_stops.len() != input.origin_candidate_indices.len()
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input.destination_stops.len() != input.destination_candidate_indices.len()
            || input
                .origin_stops
                .iter()
                .chain(input.destination_stops.iter())
                .any(|stop| *stop as usize >= self.stop_count)
            || input
                .origin_walk_seconds
                .iter()
                .chain(input.destination_walk_seconds.iter())
                .any(|seconds| !seconds.is_finite() || *seconds < 0.0)
            || !input.earliest.is_finite()
            || !input.deadline.is_finite()
            || input.deadline < input.earliest
        {
            return Err(Error::from_reason(
                "Rust arrive-by query arrays or bounds are inconsistent.",
            ));
        }

        if input.maximum_boardings.is_some() {
            let result = self.route_arrive_by_many_csa(TimetableArriveByManyQueryInput {
                origin_offsets: vec![0, input.origin_stops.len() as u32],
                origin_stops: input.origin_stops,
                origin_walk_seconds: input.origin_walk_seconds,
                allow_pre_ride_transfers: vec![input.allow_pre_ride_transfers],
                destination_stops: input.destination_stops,
                destination_walk_seconds: input.destination_walk_seconds,
                earliest: input.earliest,
                deadline: input.deadline,
                excluded_trips: Vec::new(),
                allow_post_ride_transfers: input.allow_post_ride_transfers,
                maximum_boardings: input.maximum_boardings,
            })?;
            let latest = result.latest_departures[0];
            return Ok(TimetableArriveByQueryResult {
                supported: true,
                status: if latest.is_finite() {
                    "ready"
                } else {
                    "blocked"
                }
                .to_owned(),
                reason: None,
                latest_departure: latest.is_finite().then_some(latest),
                candidate_count: u32::from(latest.is_finite()),
                verified_candidates: u32::from(latest.is_finite()),
                query_ns: started.elapsed().as_nanos() as f64,
                engine_query_ns: result.query_ns,
                scanned_departures: result.scanned_departures,
                relaxed_stops: result.relaxed_stops,
                expanded_trip_runs: result.expanded_trip_runs,
                dominated_trip_boardings: result.dominated_trip_boardings,
                explicit_transfer_checks: result.explicit_transfer_checks,
            });
        }
        let Self {
            stop_count: _,
            run_count: _,
            departure_seconds: _,
            arrival_seconds: _,
            from_stop: _,
            to_stop: _,
            sequence: _,
            segment_trip: _,
            segment_run: _,
            continuity_break: _,
            can_board: _,
            can_alight: _,
            trip_start: _,
            departure_offset: _,
            departure_events: _,
            transfer_offset,
            transfer_edges,
            forbidden_same_stop,
            same_stop_transfer_minimum,
            scan_events,
            scan_times,
            scan_time_offsets,
            scan_time_needs_closure,
            scan_arrivals,
            scan_journeys: _,
            run_start: _,
            run_end: _,
            reverse_transfer_offset,
            reverse_transfer_edges,
            exit_event_offset: _,
            exit_events: _,
            workspace,
            many_workspace: _,
            forward_workspace: _,
            profile_workspace: _,
        } = self;
        let epoch = workspace.begin_query();

        // The production transfer projection admits at most one explicit
        // transfer before the first ride. Store the minimum access offset in
        // an unused scalar label slot so arrive-by adds no stop-sized query
        // allocation.
        let maximum_offset = input.deadline - input.earliest;
        let mut minimum_origin_offset = f64::INFINITY;
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let offset = input.origin_walk_seconds[index];
            let state = stop * STATE_STRIDE + (STATE_STRIDE - 2);
            if offset > maximum_offset
                || (workspace.labels[state].generation == epoch
                    && offset >= workspace.labels[state].arrival)
            {
                continue;
            }
            retain_reverse_origin_offset(workspace, epoch, stop, offset);
            minimum_origin_offset = minimum_origin_offset.min(offset);
        }
        if input.allow_pre_ride_transfers {
            for index in 0..input.origin_stops.len() {
                let source = input.origin_stops[index] as usize;
                let source_offset = input.origin_walk_seconds[index];
                if source_offset > maximum_offset {
                    continue;
                }
                let start = transfer_offset[source] as usize;
                let end = transfer_offset[source + 1] as usize;
                for edge in &transfer_edges[start..end] {
                    let target = edge.stop();
                    let offset = source_offset + f64::from(edge.duration());
                    let state = target * STATE_STRIDE + (STATE_STRIDE - 2);
                    if offset > maximum_offset
                        || (workspace.labels[state].generation == epoch
                            && offset >= workspace.labels[state].arrival)
                    {
                        continue;
                    }
                    retain_reverse_origin_offset(workspace, epoch, target, offset);
                    minimum_origin_offset = minimum_origin_offset.min(offset);
                }
            }
        }

        // A post-ride state may finish directly, board another run after the
        // standard same-stop interchange time, or traverse exactly one
        // explicit transfer whose duration already represents interchange.
        // Seed both deadline forms at each destination, then propagate every
        // newly discovered boarding opportunity while scanning the timetable
        // once in reverse time order.
        let engine_started = Instant::now();
        let mut stats = SearchStats::default();
        let mut latest_destination_deadline = f64::NEG_INFINITY;
        for index in 0..input.destination_stops.len() {
            let stop = input.destination_stops[index] as usize;
            let destination_deadline = input.deadline - input.destination_walk_seconds[index];
            if destination_deadline < input.earliest {
                continue;
            }
            latest_destination_deadline = latest_destination_deadline.max(destination_deadline);
            relax_reverse_post_ride_deadline(
                workspace,
                epoch,
                &mut stats,
                stop,
                destination_deadline,
                input.earliest,
            );
            if input.allow_post_ride_transfers.unwrap_or(true) {
                relax_reverse_transfer_target_deadline(
                    workspace,
                    epoch,
                    &mut stats,
                    stop,
                    destination_deadline,
                    input.earliest,
                    reverse_transfer_offset,
                    reverse_transfer_edges,
                );
            }
        }
        let mut latest_departure = None;
        let first_boarding = input.earliest + minimum_origin_offset;
        let first_time = scan_time_lower_bound(scan_times, first_boarding);
        let time_end = scan_time_upper_bound(scan_times, latest_destination_deadline);
        'time_scan: for time_index in (first_time..time_end).rev() {
            let departure = f64::from(scan_times[time_index]);
            // Events are ordered by decreasing departure. Once even the
            // shortest origin access cannot improve the retained departure,
            // no earlier event can improve it either.
            if latest_departure.is_some_and(|latest| departure - minimum_origin_offset <= latest) {
                break;
            }
            let start = scan_time_offsets[time_index] as usize;
            let end = scan_time_offsets[time_index + 1] as usize;
            loop {
                let previous_changes = (stats.relaxed_stops, stats.expanded_trip_runs);
                stats.scanned_departures += (end - start) as u32;
                for connection in (start..end).rev() {
                    let event = scan_events[connection];
                    let flags = event.flags();
                    let stop = event.source_stop();
                    let run = event.run();
                    let arrival = scan_arrivals[connection];
                    let run_was_feasible = workspace.run_generation[run] == epoch
                        && workspace.expanded_run_start[run] >= connection as i32;
                    let direct_exit_feasible = flags & SCAN_CAN_ALIGHT != 0
                        && workspace.destination_generation[arrival.to as usize] == epoch
                        && f64::from(arrival.arrival)
                            <= workspace.destination_egress[arrival.to as usize];
                    let boardable_path = run_was_feasible || direct_exit_feasible;

                    if flags & SCAN_CAN_BOARD != 0 && boardable_path {
                        let origin_state = stop * STATE_STRIDE + (STATE_STRIDE - 2);
                        if workspace.labels[origin_state].generation == epoch {
                            let origin_offset = workspace.labels[origin_state].arrival;
                            let candidate = departure - origin_offset;
                            if candidate >= input.earliest
                                && candidate <= input.deadline
                                && latest_departure.is_none_or(|latest| candidate > latest)
                            {
                                latest_departure = Some(candidate);
                                // This is the largest physical departure possible
                                // at the latest timetable time still under
                                // consideration. Neither the rest of this bucket
                                // nor an earlier one can improve it.
                                if origin_offset <= minimum_origin_offset {
                                    break 'time_scan;
                                }
                            }
                        }

                        if forbidden_same_stop[stop] == 0 {
                            relax_reverse_post_ride_deadline(
                                workspace,
                                epoch,
                                &mut stats,
                                stop,
                                departure - f64::from(same_stop_transfer_minimum[stop]),
                                input.earliest,
                            );
                            relax_reverse_transfer_target_deadline(
                                workspace,
                                epoch,
                                &mut stats,
                                stop,
                                departure,
                                input.earliest,
                                reverse_transfer_offset,
                                reverse_transfer_edges,
                            );
                        }
                    }

                    let bridge_exit_feasible = flags & SCAN_BRIDGE_EXIT != 0
                        && workspace.destination_generation[stop] == epoch
                        && departure <= workspace.destination_egress[stop];
                    let exit_connection = if direct_exit_feasible {
                        connection as i32
                    } else {
                        connection as i32 - 1
                    };
                    if (direct_exit_feasible || bridge_exit_feasible)
                        && (workspace.run_generation[run] != epoch
                            || exit_connection > workspace.expanded_run_start[run])
                    {
                        workspace.run_generation[run] = epoch;
                        workspace.expanded_run_start[run] = exit_connection;
                        stats.expanded_trip_runs = stats.expanded_trip_runs.saturating_add(1);
                    } else if run_was_feasible && flags & SCAN_CAN_BOARD != 0 {
                        stats.dominated_trip_boardings =
                            stats.dominated_trip_boardings.saturating_add(1);
                    }
                }
                if !scan_time_needs_closure[time_index]
                    || previous_changes == (stats.relaxed_stops, stats.expanded_trip_runs)
                {
                    break;
                }
            }
        }
        let engine_query_ns = engine_started.elapsed().as_nanos() as f64;
        // The reverse scan resolves one exact upper boundary. The uncommon
        // presentation-only recovery enumerates earlier departures lazily in
        // JavaScript if forward materialization rejects that boundary.
        let verified_candidates = u32::from(latest_departure.is_some());
        let candidate_count = verified_candidates;

        Ok(TimetableArriveByQueryResult {
            supported: true,
            status: if latest_departure.is_some() {
                "ready".to_owned()
            } else {
                "blocked".to_owned()
            },
            reason: None,
            latest_departure,
            candidate_count,
            verified_candidates,
            query_ns: started.elapsed().as_nanos() as f64,
            engine_query_ns,
            scanned_departures: stats.scanned_departures,
            relaxed_stops: stats.relaxed_stops,
            expanded_trip_runs: stats.expanded_trip_runs,
            dominated_trip_boardings: stats.dominated_trip_boardings,
            explicit_transfer_checks: stats.explicit_transfer_checks,
        })
    }

    /// Schedule both time directions inside one Node-API boundary. A fixed
    /// departure shares a scan across destinations; a fixed deadline shares a
    /// reverse scan across origins. Matrix orientation never changes the time
    /// constraint or reverses the directed physical network.
    #[napi]
    pub fn route_matrix_csa(
        &mut self,
        input: TimetableMatrixQueryInput,
    ) -> napi::Result<TimetableMatrixQueryResult> {
        let started = Instant::now();
        let origin_count = input.origin_offsets.len().saturating_sub(1);
        let destination_count = input.destination_offsets.len().saturating_sub(1);
        if input
            .allow_post_ride_transfers
            .as_ref()
            .is_some_and(|flags| flags.len() != destination_count)
        {
            return Err(Error::from_reason(
                "Rust timetable terminal transfer flags must match destinations.",
            ));
        }
        let valid_offsets = |offsets: &[u32], count: usize| {
            offsets.first() == Some(&0)
                && offsets.last().is_some_and(|last| *last as usize == count)
                && offsets.windows(2).all(|pair| pair[0] <= pair[1])
        };
        if origin_count == 0
            || destination_count == 0
            || origin_count.saturating_mul(destination_count) > crate::MAXIMUM_MATRIX_PAIRS
            || !valid_offsets(&input.origin_offsets, input.origin_stops.len())
            || !valid_offsets(&input.destination_offsets, input.destination_stops.len())
            || input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input.allow_pre_ride_transfers.len() != origin_count
        {
            return Err(Error::from_reason(
                "Rust timetable matrix arrays or size are inconsistent.",
            ));
        }
        let mut output = TimetableMatrixQueryResult {
            journeys: None,
            times: vec![
                if input.arrive_by {
                    f64::NEG_INFINITY
                } else {
                    f64::INFINITY
                };
                origin_count * destination_count
            ],
            forward_searches: 0,
            reverse_searches: 0,
            query_ns: 0.0,
            scanned_departures: 0.0,
            relaxed_stops: 0.0,
            expanded_trip_runs: 0.0,
            dominated_trip_boardings: 0.0,
            explicit_transfer_checks: 0.0,
        };
        if input.arrive_by {
            for destination in 0..destination_count {
                let range = input.destination_offsets[destination] as usize
                    ..input.destination_offsets[destination + 1] as usize;
                let result = self.route_arrive_by_many_csa(TimetableArriveByManyQueryInput {
                    origin_offsets: input.origin_offsets.clone(),
                    origin_stops: input.origin_stops.clone(),
                    origin_walk_seconds: input.origin_walk_seconds.clone(),
                    allow_pre_ride_transfers: input.allow_pre_ride_transfers.clone(),
                    allow_post_ride_transfers: input
                        .allow_post_ride_transfers
                        .as_ref()
                        .map(|flags| flags[destination]),
                    destination_stops: input.destination_stops[range.clone()].to_vec(),
                    destination_walk_seconds: input.destination_walk_seconds[range].to_vec(),
                    earliest: input.departure,
                    deadline: input.horizon,
                    excluded_trips: Vec::new(),
                    maximum_boardings: input.maximum_boardings,
                })?;
                for (origin, departure) in result.latest_departures.into_iter().enumerate() {
                    output.times[origin * destination_count + destination] = departure;
                }
                output.reverse_searches += 1;
                output.scanned_departures += f64::from(result.scanned_departures);
                output.relaxed_stops += f64::from(result.relaxed_stops);
                output.expanded_trip_runs += f64::from(result.expanded_trip_runs);
                output.dominated_trip_boardings += f64::from(result.dominated_trip_boardings);
                output.explicit_transfer_checks += f64::from(result.explicit_transfer_checks);
            }
        } else {
            for origin in 0..origin_count {
                let range = input.origin_offsets[origin] as usize
                    ..input.origin_offsets[origin + 1] as usize;
                let result = self.route_many_csa(TimetableManyQueryInput {
                    origin_stops: input.origin_stops[range.clone()].to_vec(),
                    origin_walk_seconds: input.origin_walk_seconds[range].to_vec(),
                    allow_post_ride_transfers: input.allow_post_ride_transfers.clone(),
                    destination_offsets: input.destination_offsets.clone(),
                    destination_stops: input.destination_stops.clone(),
                    destination_walk_seconds: input.destination_walk_seconds.clone(),
                    departure: input.departure,
                    horizon: input.horizon,
                    allow_pre_ride_transfers: input.allow_pre_ride_transfers[origin],
                    excluded_trips: Vec::new(),
                    maximum_boardings: input.maximum_boardings,
                })?;
                output.times[origin * destination_count..(origin + 1) * destination_count]
                    .copy_from_slice(&result.best_arrivals);
                output.forward_searches += 1;
                output.scanned_departures += f64::from(result.scanned_departures);
                output.relaxed_stops += f64::from(result.relaxed_stops);
                output.expanded_trip_runs += f64::from(result.expanded_trip_runs);
                output.dominated_trip_boardings += f64::from(result.dominated_trip_boardings);
                output.explicit_transfer_checks += f64::from(result.explicit_transfer_checks);
            }
        }
        if input.include_journeys.unwrap_or(false) {
            output = self.matrix_journeys(&input, output)?;
        }
        output.query_ns = started.elapsed().as_nanos() as f64;
        Ok(output)
    }

    /// One destination and deadline, shared by every origin. Reverse labels
    /// retain the latest feasible first boarding at each stop; endpoint access
    /// and its permitted single pre-ride transfer are reduced only after the
    /// timetable scan. The scalar workspace is reused without stop-sized
    /// allocations or a timetable scan per origin.
    #[napi]
    pub fn route_arrive_by_many_csa(
        &mut self,
        input: TimetableArriveByManyQueryInput,
    ) -> napi::Result<TimetableArriveByManyQueryResult> {
        let started = Instant::now();
        let origin_count = input.origin_offsets.len().saturating_sub(1);
        if origin_count == 0
            || origin_count > crate::MAXIMUM_MATRIX_PAIRS
            || input.origin_offsets[0] != 0
            || input.origin_offsets[origin_count] as usize != input.origin_stops.len()
            || input
                .origin_offsets
                .windows(2)
                .any(|pair| pair[0] > pair[1])
            || input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.allow_pre_ride_transfers.len() != origin_count
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input
                .origin_stops
                .iter()
                .chain(&input.destination_stops)
                .any(|stop| *stop as usize >= self.stop_count)
            || input
                .origin_walk_seconds
                .iter()
                .chain(&input.destination_walk_seconds)
                .any(|seconds| !seconds.is_finite() || *seconds < 0.0)
            || input
                .excluded_trips
                .iter()
                .any(|trip| *trip as usize >= self.many_workspace.excluded_trip_generation.len())
            || !input.earliest.is_finite()
            || input.earliest < 0.0
            || !input.deadline.is_finite()
            || input.deadline < input.earliest
        {
            return Err(Error::from_reason(
                "Rust arrive-by many-to-one query arrays or bounds are inconsistent.",
            ));
        }
        let maximum_layer = boarding_layers(input.maximum_boardings)?;
        let first_layer = usize::from(input.maximum_boardings.is_some());
        let workspace = &mut self.workspace;
        workspace.ensure_dimensions(
            self.stop_count * (maximum_layer + 1),
            self.run_count * (maximum_layer + 1),
        );
        let epoch = workspace.begin_query();
        let excluded_epoch = self.many_workspace.begin_query();
        for trip in &input.excluded_trips {
            self.many_workspace.excluded_trip_generation[*trip as usize] = excluded_epoch;
        }
        // A scalar request can stop at a proven latest departure. Reuse an
        // otherwise unused label slot for its directed access offsets; bulk
        // requests still share the full scan without per-origin bookkeeping.
        let mut minimum_origin_offset = f64::INFINITY;
        if origin_count == 1 {
            for (&stop, &walk) in input.origin_stops.iter().zip(&input.origin_walk_seconds) {
                retain_reverse_origin_offset(workspace, epoch, stop as usize, walk);
                minimum_origin_offset = minimum_origin_offset.min(walk);
                if input.allow_pre_ride_transfers[0] {
                    let edges = &self.transfer_edges[self.transfer_offset[stop as usize] as usize
                        ..self.transfer_offset[stop as usize + 1] as usize];
                    for edge in edges {
                        let offset = walk + f64::from(edge.duration());
                        retain_reverse_origin_offset(workspace, epoch, edge.stop(), offset);
                        minimum_origin_offset = minimum_origin_offset.min(offset);
                    }
                }
            }
        }
        let mut latest_origin_departure = f64::NEG_INFINITY;
        let mut stats = SearchStats::default();
        let mut excluded_departures = 0_u32;
        let mut latest_destination_deadline = f64::NEG_INFINITY;
        for (stop, walk) in input
            .destination_stops
            .iter()
            .zip(&input.destination_walk_seconds)
        {
            let deadline = input.deadline - walk;
            if deadline < input.earliest {
                continue;
            }
            latest_destination_deadline = latest_destination_deadline.max(deadline);
            relax_reverse_post_ride_deadline(
                workspace,
                epoch,
                &mut stats,
                *stop as usize,
                deadline,
                input.earliest,
            );
            if input.allow_post_ride_transfers.unwrap_or(true) {
                relax_reverse_transfer_target_deadline(
                    workspace,
                    epoch,
                    &mut stats,
                    *stop as usize,
                    deadline,
                    input.earliest,
                    &self.reverse_transfer_offset,
                    &self.reverse_transfer_edges,
                );
            }
        }
        let first_time = scan_time_lower_bound(&self.scan_times, input.earliest);
        let time_end = scan_time_upper_bound(&self.scan_times, latest_destination_deadline);
        for time_index in (first_time..time_end).rev() {
            let departure = f64::from(self.scan_times[time_index]);
            if origin_count == 1 && departure - minimum_origin_offset <= latest_origin_departure {
                break;
            }
            let start = self.scan_time_offsets[time_index] as usize;
            let end = self.scan_time_offsets[time_index + 1] as usize;
            loop {
                let previous_changes = (stats.relaxed_stops, stats.expanded_trip_runs);
                stats.scanned_departures = stats
                    .scanned_departures
                    .saturating_add(((end - start) * (maximum_layer + 1 - first_layer)) as u32);
                for connection in (start..end).rev() {
                    if !input.excluded_trips.is_empty()
                        && self.many_workspace.excluded_trip_generation
                            [self.scan_journeys[connection].trip as usize]
                            == excluded_epoch
                    {
                        excluded_departures = excluded_departures.saturating_add(1);
                        continue;
                    }
                    for layer in first_layer..=maximum_layer {
                        let input_offset = layer.saturating_sub(1) * self.stop_count;
                        let output_offset = layer * self.stop_count;
                        let event = self.scan_events[connection];
                        let flags = event.flags();
                        let base_stop = event.source_stop();
                        let stop = output_offset + base_stop;
                        let exit_stop = input_offset + base_stop;
                        let run = layer * self.run_count + event.run();
                        let arrival = self.scan_arrivals[connection];
                        let run_was_feasible = workspace.run_generation[run] == epoch
                            && workspace.expanded_run_start[run] >= connection as i32;
                        let direct_exit_feasible = flags & SCAN_CAN_ALIGHT != 0
                            && workspace.destination_generation[input_offset + arrival.to as usize]
                                == epoch
                            && f64::from(arrival.arrival)
                                <= workspace.destination_egress[input_offset + arrival.to as usize];
                        if flags & SCAN_CAN_BOARD != 0 && (run_was_feasible || direct_exit_feasible)
                        {
                            if origin_count == 1 {
                                let access =
                                    workspace.labels[base_stop * STATE_STRIDE + (STATE_STRIDE - 2)];
                                if access.generation == epoch {
                                    latest_origin_departure =
                                        latest_origin_departure.max(departure - access.arrival);
                                }
                            }
                            let boarding =
                                &mut workspace.labels[stop * STATE_STRIDE + (STATE_STRIDE - 1)];
                            if boarding.generation != epoch || departure > boarding.arrival {
                                boarding.generation = epoch;
                                boarding.arrival = departure;
                            }
                            if self.forbidden_same_stop[base_stop] == 0 {
                                relax_reverse_post_ride_deadline(
                                    workspace,
                                    epoch,
                                    &mut stats,
                                    stop,
                                    departure
                                        - f64::from(self.same_stop_transfer_minimum[base_stop]),
                                    input.earliest,
                                );
                                relax_reverse_transfer_target_deadline(
                                    workspace,
                                    epoch,
                                    &mut stats,
                                    stop,
                                    departure,
                                    input.earliest,
                                    &self.reverse_transfer_offset,
                                    &self.reverse_transfer_edges,
                                );
                            }
                        }
                        let bridge_exit_feasible = flags & SCAN_BRIDGE_EXIT != 0
                            && workspace.destination_generation[exit_stop] == epoch
                            && departure <= workspace.destination_egress[exit_stop];
                        let exit_connection = if direct_exit_feasible {
                            connection as i32
                        } else {
                            connection as i32 - 1
                        };
                        if (direct_exit_feasible || bridge_exit_feasible)
                            && (workspace.run_generation[run] != epoch
                                || exit_connection > workspace.expanded_run_start[run])
                        {
                            workspace.run_generation[run] = epoch;
                            workspace.expanded_run_start[run] = exit_connection;
                            stats.expanded_trip_runs = stats.expanded_trip_runs.saturating_add(1);
                        } else if run_was_feasible && flags & SCAN_CAN_BOARD != 0 {
                            stats.dominated_trip_boardings =
                                stats.dominated_trip_boardings.saturating_add(1);
                        }
                    }
                }
                if !self.scan_time_needs_closure[time_index]
                    || previous_changes == (stats.relaxed_stops, stats.expanded_trip_runs)
                {
                    break;
                }
            }
        }
        let mut latest_departures = vec![f64::NEG_INFINITY; origin_count];
        for (origin, latest) in latest_departures.iter_mut().enumerate() {
            let start = input.origin_offsets[origin] as usize;
            let end = input.origin_offsets[origin + 1] as usize;
            for seed in start..end {
                for layer in first_layer..=maximum_layer {
                    let layer_offset = layer * self.stop_count;
                    let base_stop = input.origin_stops[seed] as usize;
                    let stop = layer_offset + base_stop;
                    let walk = input.origin_walk_seconds[seed];
                    let boarding = workspace.labels[stop * STATE_STRIDE + (STATE_STRIDE - 1)];
                    if boarding.generation == epoch {
                        *latest = latest.max(boarding.arrival - walk);
                    }
                    if input.allow_pre_ride_transfers[origin] {
                        let edges = &self.transfer_edges[self.transfer_offset[base_stop] as usize
                            ..self.transfer_offset[base_stop + 1] as usize];
                        stats.explicit_transfer_checks = stats
                            .explicit_transfer_checks
                            .saturating_add(edges.len() as u32);
                        for edge in edges {
                            let boarding = workspace.labels
                                [(layer_offset + edge.stop()) * STATE_STRIDE + (STATE_STRIDE - 1)];
                            if boarding.generation == epoch {
                                *latest = latest
                                    .max(boarding.arrival - walk - f64::from(edge.duration()));
                            }
                        }
                    }
                }
            }
            if *latest < input.earliest {
                *latest = f64::NEG_INFINITY;
            }
        }
        Ok(TimetableArriveByManyQueryResult {
            latest_departures,
            query_ns: started.elapsed().as_nanos() as f64,
            scanned_departures: stats.scanned_departures,
            excluded_departures,
            relaxed_stops: stats.relaxed_stops,
            expanded_trip_runs: stats.expanded_trip_runs,
            dominated_trip_boardings: stats.dominated_trip_boardings,
            explicit_transfer_checks: stats.explicit_transfer_checks,
        })
    }

    #[napi]
    pub fn route_many_csa(
        &mut self,
        input: TimetableManyQueryInput,
    ) -> napi::Result<TimetableManyQueryResult> {
        let started = Instant::now();
        let destination_count = input.destination_offsets.len().saturating_sub(1);
        if input
            .allow_post_ride_transfers
            .as_ref()
            .is_some_and(|flags| flags.len() != destination_count)
        {
            return Err(Error::from_reason(
                "Rust timetable terminal transfer flags must match destinations.",
            ));
        }
        if input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input.destination_offsets.len() < 2
            || input.destination_offsets[0] != 0
            || input.destination_offsets[destination_count] as usize
                != input.destination_stops.len()
            || input
                .destination_offsets
                .windows(2)
                .any(|offsets| offsets[0] > offsets[1])
            || input
                .origin_stops
                .iter()
                .chain(input.destination_stops.iter())
                .any(|stop| *stop as usize >= self.stop_count)
            || input
                .origin_walk_seconds
                .iter()
                .chain(input.destination_walk_seconds.iter())
                .any(|seconds| !seconds.is_finite() || *seconds < 0.0)
            || input
                .excluded_trips
                .iter()
                .any(|trip| *trip as usize >= self.many_workspace.excluded_trip_generation.len())
            || !input.departure.is_finite()
            || !input.horizon.is_finite()
            || input.departure < 0.0
            || input.horizon < input.departure
        {
            return Err(Error::from_reason(
                "Rust one-to-many timetable query arrays or bounds are inconsistent.",
            ));
        }

        let maximum_layer = boarding_layers(input.maximum_boardings)?;
        let first_layer = usize::from(input.maximum_boardings.is_some());
        let base_stop_count = self.stop_count;
        let base_run_count = self.run_count;
        self.many_workspace.ensure_dimensions(
            base_stop_count * (maximum_layer + 1),
            base_run_count * (maximum_layer + 1),
        );

        let Self {
            stop_count: _,
            run_count: _,
            departure_seconds: _,
            arrival_seconds: _,
            from_stop: _,
            to_stop: _,
            sequence: _,
            segment_trip: _,
            segment_run: _,
            continuity_break: _,
            can_board: _,
            can_alight: _,
            trip_start: _,
            departure_offset,
            departure_events,
            transfer_offset,
            transfer_edges,
            forbidden_same_stop,
            same_stop_transfer_minimum,
            scan_events,
            scan_times,
            scan_time_offsets,
            scan_time_needs_closure,
            scan_arrivals,
            scan_journeys,
            run_start: _,
            run_end: _,
            reverse_transfer_offset: _,
            reverse_transfer_edges: _,
            exit_event_offset: _,
            exit_events: _,
            workspace: _,
            many_workspace,
            forward_workspace: _,
            profile_workspace: _,
        } = self;
        let epoch = many_workspace.begin_query();
        let has_excluded_trips = !input.excluded_trips.is_empty();
        for trip in &input.excluded_trips {
            many_workspace.excluded_trip_generation[*trip as usize] = epoch;
        }
        let mut stats = SearchStats::default();
        let mut excluded_departures = 0_u32;
        let mut origin_seeds = 0_u32;
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let arrival = input.departure + input.origin_walk_seconds[index];
            if !relax_many(
                many_workspace,
                epoch,
                &mut stats,
                stop,
                arrival,
                false,
                false,
                false,
                input.horizon,
                false,
            ) {
                continue;
            }
            origin_seeds = origin_seeds.saturating_add(1);
            if input.allow_pre_ride_transfers {
                expand_many_transfer_edges(
                    many_workspace,
                    epoch,
                    &mut stats,
                    transfer_offset,
                    transfer_edges,
                    stop,
                    arrival,
                    false,
                    input.horizon,
                );
            }
        }
        if origin_seeds == 0 {
            return Ok(TimetableManyQueryResult {
                supported: false,
                status: "unsupported".to_owned(),
                reason: Some("origin_outside_kernel".to_owned()),
                algorithm: "rust_resident_generation_tagged_connection_scan_one_to_many".to_owned(),
                best_arrivals: vec![f64::INFINITY; destination_count],
                best_destination_index: None,
                chain_kinds: Vec::new(),
                chain_from_stops: Vec::new(),
                chain_to_stops: Vec::new(),
                chain_trip_or_candidate: Vec::new(),
                chain_board_sequences: Vec::new(),
                chain_alight_sequences: Vec::new(),
                chain_durations: Vec::new(),
                chain_arrivals: Vec::new(),
                query_ns: started.elapsed().as_nanos() as f64,
                scanned_departures: 0,
                excluded_departures: 0,
                relaxed_stops: stats.relaxed_stops,
                expanded_trip_runs: 0,
                dominated_trip_boardings: 0,
                explicit_transfer_checks: stats.explicit_transfer_checks,
            });
        }

        // Coordinate access cannot board before its endpoint walk reaches an
        // origin stop. Start at the first indexed departure that any origin
        // can board; earlier timetable events are provably irrelevant.
        let scan_start = if input.allow_pre_ride_transfers {
            input.departure
        } else {
            earliest_boardable_departure(
                departure_offset,
                departure_events,
                &input.origin_stops,
                &input.origin_walk_seconds,
                input.departure,
            )
        };
        let mut time_index = scan_time_lower_bound(scan_times, scan_start);
        while time_index < scan_times.len() {
            let connection_departure = scan_times[time_index] as f64;
            if connection_departure > input.horizon {
                break;
            }
            let start = scan_time_offsets[time_index] as usize;
            let end = scan_time_offsets[time_index + 1] as usize;
            let bucket_events = &scan_events[start..end];
            let bucket_arrivals = &scan_arrivals[start..end];
            loop {
                let previous_changes = (stats.relaxed_stops, stats.expanded_trip_runs);
                stats.scanned_departures = stats
                    .scanned_departures
                    .saturating_add(((end - start) * (maximum_layer + 1 - first_layer)) as u32);
                for (offset, (&event, &arrival)) in
                    bucket_events.iter().zip(bucket_arrivals).enumerate()
                {
                    for layer in first_layer..=maximum_layer {
                        let output_offset = layer * base_stop_count;
                        let input_offset = layer.saturating_sub(1) * base_stop_count;
                        let connection = start + offset;
                        let flags = event.flags();
                        let base_stop = event.source_stop();
                        let stop = input_offset + base_stop;
                        let run = layer * base_run_count + event.run();
                        if has_excluded_trips {
                            let trip = scan_journeys[connection].trip as usize;
                            if many_workspace.excluded_trip_generation[trip] == epoch {
                                excluded_departures = excluded_departures.saturating_add(1);
                                continue;
                            }
                        }
                        if flags & SCAN_CAN_BOARD != 0
                            && many_workspace.stop_generation[stop] == epoch
                            && many_workspace.active_state_mask[stop] != 0
                        {
                            let mut active_states = many_workspace.active_state_mask[stop];
                            let mut boardable = false;
                            while active_states != 0 {
                                let state_flags = active_states.trailing_zeros() as usize;
                                active_states &= active_states - 1;
                                let has_ride = state_flags & 4 != 0;
                                if has_ride && forbidden_same_stop[base_stop] == 1 {
                                    continue;
                                }
                                let state = stop * STATE_STRIDE + state_flags;
                                if boarding_ready_time(
                                    many_workspace.labels[state],
                                    has_ride,
                                    state_flags & 1 != 0,
                                    same_stop_transfer_minimum[base_stop],
                                ) <= connection_departure
                                {
                                    boardable = true;
                                    break;
                                }
                            }
                            if boardable {
                                if many_workspace.run_generation[run] != epoch
                                    || (connection as u32)
                                        < many_workspace.run_boarding_connection[run]
                                {
                                    many_workspace.run_generation[run] = epoch;
                                    many_workspace.run_boarding_connection[run] = connection as u32;
                                    stats.expanded_trip_runs =
                                        stats.expanded_trip_runs.saturating_add(1);
                                } else {
                                    stats.dominated_trip_boardings =
                                        stats.dominated_trip_boardings.saturating_add(1);
                                }
                            }
                        }
                        if many_workspace.run_generation[run] != epoch {
                            continue;
                        }
                        let boarding = many_workspace.run_boarding_connection[run] as usize;
                        if connection < boarding {
                            continue;
                        }
                        if connection > boarding && flags & SCAN_BRIDGE_EXIT != 0 {
                            let bridge_stop = output_offset + event.source_stop();
                            if relax_many(
                                many_workspace,
                                epoch,
                                &mut stats,
                                bridge_stop,
                                connection_departure,
                                true,
                                true,
                                true,
                                input.horizon,
                                false,
                            ) {
                                expand_many_transfer_edges(
                                    many_workspace,
                                    epoch,
                                    &mut stats,
                                    transfer_offset,
                                    transfer_edges,
                                    bridge_stop,
                                    connection_departure,
                                    true,
                                    input.horizon,
                                );
                            }
                        }
                        if flags & SCAN_CAN_ALIGHT == 0 || arrival.arrival as f64 > input.horizon {
                            continue;
                        }
                        let alight_stop = output_offset + arrival.to as usize;
                        if relax_many(
                            many_workspace,
                            epoch,
                            &mut stats,
                            alight_stop,
                            arrival.arrival as f64,
                            true,
                            true,
                            true,
                            input.horizon,
                            false,
                        ) {
                            expand_many_transfer_edges(
                                many_workspace,
                                epoch,
                                &mut stats,
                                transfer_offset,
                                transfer_edges,
                                alight_stop,
                                arrival.arrival as f64,
                                true,
                                input.horizon,
                            );
                        }
                    }
                }
                if !scan_time_needs_closure[time_index]
                    || previous_changes == (stats.relaxed_stops, stats.expanded_trip_runs)
                {
                    break;
                }
            }
            time_index += 1;
        }

        let mut best_arrivals = vec![f64::INFINITY; destination_count];
        for (destination, best) in best_arrivals.iter_mut().enumerate() {
            let start = input.destination_offsets[destination] as usize;
            let end = input.destination_offsets[destination + 1] as usize;
            for seed in start..end {
                for layer in first_layer..=maximum_layer {
                    let stop = layer * base_stop_count + input.destination_stops[seed] as usize;
                    for flags in [6_usize, 7] {
                        if flags == 6
                            && input
                                .allow_post_ride_transfers
                                .as_ref()
                                .is_some_and(|allowed| !allowed[destination])
                        {
                            continue;
                        }
                        let state = stop * STATE_STRIDE + flags;
                        if many_workspace.state_generation[state] != epoch {
                            continue;
                        }
                        let arrival =
                            many_workspace.labels[state] + input.destination_walk_seconds[seed];
                        // The horizon bounds the timetable scan. As in the scalar
                        // point operator, a terminal destination egress may finish
                        // after that boundary once its final ride has alighted
                        // within the scan horizon.
                        if arrival < *best {
                            *best = arrival;
                        }
                    }
                }
            }
        }
        Ok(TimetableManyQueryResult {
            supported: true,
            status: "complete".to_owned(),
            reason: None,
            algorithm: "rust_resident_generation_tagged_connection_scan_one_to_many".to_owned(),
            best_arrivals,
            best_destination_index: None,
            chain_kinds: Vec::new(),
            chain_from_stops: Vec::new(),
            chain_to_stops: Vec::new(),
            chain_trip_or_candidate: Vec::new(),
            chain_board_sequences: Vec::new(),
            chain_alight_sequences: Vec::new(),
            chain_durations: Vec::new(),
            chain_arrivals: Vec::new(),
            query_ns: started.elapsed().as_nanos() as f64,
            scanned_departures: stats.scanned_departures,
            excluded_departures,
            relaxed_stops: stats.relaxed_stops,
            expanded_trip_runs: stats.expanded_trip_runs,
            dominated_trip_boardings: stats.dominated_trip_boardings,
            explicit_transfer_checks: stats.explicit_transfer_checks,
        })
    }

    /// Runs the resident timetable and finite query-scoped services as one
    /// chronological connection scan. Supplemental transfer edges join the
    /// resident and overlay stop domains, so a journey may alternate between
    /// baseline and proposed service any finite number of times admitted by
    /// the chronological event stream.
    #[napi]
    pub fn route_overlay_many_csa(
        &mut self,
        input: TimetableOverlayManyQueryInput,
    ) -> napi::Result<TimetableOverlayManyQueryResult> {
        let started = Instant::now();
        let compile_started = Instant::now();
        let overlay_stop_count = input.overlay_stop_count as usize;
        if overlay_stop_count > MAX_OVERLAY_STOPS {
            return Err(Error::from_reason(format!(
                "Rust timetable overlay exceeds the {MAX_OVERLAY_STOPS}-stop query limit."
            )));
        }
        let combined_stop_count = self
            .stop_count
            .checked_add(overlay_stop_count)
            .ok_or_else(|| Error::from_reason("Rust timetable overlay stop count overflowed."))?;
        let compiled = compile_timetable_overlay(&input, self.stop_count)?;
        let combined_run_count = self
            .run_count
            .checked_add(compiled.run_count)
            .ok_or_else(|| Error::from_reason("Rust timetable overlay run count overflowed."))?;
        if input.supplemental_transfer_offsets.len() != combined_stop_count + 1
            || input.supplemental_transfer_offsets.first().copied() != Some(0)
            || input.supplemental_transfer_offsets[combined_stop_count] as usize
                != input.supplemental_transfer_to.len()
            || input.supplemental_transfer_to.len() != input.supplemental_transfer_duration.len()
            || input
                .supplemental_transfer_offsets
                .windows(2)
                .any(|offsets| offsets[0] > offsets[1])
            || input
                .supplemental_transfer_to
                .iter()
                .any(|stop| *stop as usize >= combined_stop_count)
        {
            return Err(Error::from_reason(
                "Rust timetable overlay supplemental transfer arrays are inconsistent.",
            ));
        }
        let supplemental_transfer_edges = input
            .supplemental_transfer_to
            .iter()
            .copied()
            .zip(input.supplemental_transfer_duration.iter().copied())
            .map(|(stop, duration)| TransferEdge::new(stop, duration))
            .collect::<Vec<_>>();
        let compile_ns = compile_started.elapsed().as_nanos() as f64;
        let transient_bytes = compiled.byte_length()
            + supplemental_transfer_edges.capacity() * std::mem::size_of::<TransferEdge>();

        let destination_count = input.destination_offsets.len().saturating_sub(1);
        if input
            .allow_post_ride_transfers
            .as_ref()
            .is_some_and(|flags| flags.len() != destination_count)
        {
            return Err(Error::from_reason(
                "Rust timetable terminal transfer flags must match destinations.",
            ));
        }
        if input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input.destination_offsets.len() < 2
            || input.destination_offsets[0] != 0
            || input.destination_offsets[destination_count] as usize
                != input.destination_stops.len()
            || input
                .destination_offsets
                .windows(2)
                .any(|offsets| offsets[0] > offsets[1])
            || input
                .origin_stops
                .iter()
                .chain(input.destination_stops.iter())
                .any(|stop| *stop as usize >= combined_stop_count)
            || input
                .origin_walk_seconds
                .iter()
                .chain(input.destination_walk_seconds.iter())
                .any(|seconds| !seconds.is_finite() || *seconds < 0.0)
            || input
                .excluded_trips
                .iter()
                .any(|trip| *trip as usize >= self.many_workspace.excluded_trip_generation.len())
            || !input.departure.is_finite()
            || !input.horizon.is_finite()
            || input.departure < 0.0
            || input.horizon < input.departure
        {
            return Err(Error::from_reason(
                "Rust overlay one-to-many timetable query arrays or bounds are inconsistent.",
            ));
        }
        if input
            .origin_candidate_indices
            .as_ref()
            .is_some_and(|indices| indices.len() != input.origin_stops.len())
            || input
                .destination_candidate_indices
                .as_ref()
                .is_some_and(|indices| indices.len() != input.destination_stops.len())
        {
            return Err(Error::from_reason(
                "Rust overlay candidate-index arrays are inconsistent.",
            ));
        }
        let scan_started = Instant::now();
        let origin_candidate_indices = input.origin_candidate_indices.as_deref();
        let destination_candidate_indices = input.destination_candidate_indices.as_deref();

        let base_stop_count = self.stop_count;
        let base_run_count = self.run_count;
        let Self {
            stop_count: _,
            run_count: _,
            departure_seconds: _,
            arrival_seconds: _,
            from_stop: _,
            to_stop: _,
            sequence: _,
            segment_trip: _,
            segment_run: _,
            continuity_break: _,
            can_board: _,
            can_alight: _,
            trip_start: _,
            departure_offset: _,
            departure_events: _,
            transfer_offset,
            transfer_edges,
            forbidden_same_stop,
            same_stop_transfer_minimum,
            scan_events,
            scan_times,
            scan_time_offsets,
            scan_time_needs_closure,
            scan_arrivals,
            scan_journeys,
            run_start: _,
            run_end: _,
            reverse_transfer_offset: _,
            reverse_transfer_edges: _,
            exit_event_offset: _,
            exit_events: _,
            workspace: _,
            many_workspace,
            forward_workspace: _,
            profile_workspace: _,
        } = self;
        let maximum_layer = boarding_layers(input.maximum_boardings)?;
        let first_layer = usize::from(input.maximum_boardings.is_some());
        many_workspace.ensure_dimensions(
            combined_stop_count * (maximum_layer + 1),
            combined_run_count * (maximum_layer + 1),
        );
        many_workspace.predecessors.resize(
            combined_stop_count * (maximum_layer + 1) * STATE_STRIDE,
            ScalarPredecessor::default(),
        );
        many_workspace
            .run_boarding_state
            .resize(combined_run_count * (maximum_layer + 1), NO_STATE);
        let epoch = many_workspace.begin_query();
        for trip in &input.excluded_trips {
            many_workspace.excluded_trip_generation[*trip as usize] = epoch;
        }
        let mut stats = SearchStats::default();
        let mut excluded_departures = 0_u32;
        let mut origin_seeds = 0_u32;
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let arrival = input.departure + input.origin_walk_seconds[index];
            let state = relax_many_record(
                many_workspace,
                epoch,
                &mut stats,
                stop,
                arrival,
                false,
                false,
                false,
                input.horizon,
                false,
                NO_STATE,
                3,
                origin_candidate_indices
                    .and_then(|indices| indices.get(index).copied())
                    .unwrap_or(index as u32) as i32,
                0.0,
                0.0,
                0,
            );
            if state < 0 {
                continue;
            }
            origin_seeds = origin_seeds.saturating_add(1);
            if input.allow_pre_ride_transfers {
                expand_many_combined_transfer_edges_chain(
                    many_workspace,
                    epoch,
                    &mut stats,
                    base_stop_count,
                    transfer_offset,
                    transfer_edges,
                    &input.supplemental_transfer_offsets,
                    &supplemental_transfer_edges,
                    stop,
                    arrival,
                    false,
                    input.horizon,
                    state,
                );
            }
        }
        if origin_seeds == 0 {
            let workspace_bytes = many_workspace.byte_length() as f64;
            many_workspace.predecessors = Vec::new();
            many_workspace.run_boarding_state = Vec::new();
            return Ok(TimetableOverlayManyQueryResult {
                timetable: TimetableManyQueryResult {
                    supported: false,
                    status: "unsupported".to_owned(),
                    reason: Some("origin_outside_kernel".to_owned()),
                    algorithm: "rust_resident_query_overlay_connection_scan_one_to_many".to_owned(),
                    best_arrivals: vec![f64::INFINITY; destination_count],
                    best_destination_index: None,
                    chain_kinds: Vec::new(),
                    chain_from_stops: Vec::new(),
                    chain_to_stops: Vec::new(),
                    chain_trip_or_candidate: Vec::new(),
                    chain_board_sequences: Vec::new(),
                    chain_alight_sequences: Vec::new(),
                    chain_durations: Vec::new(),
                    chain_arrivals: Vec::new(),
                    query_ns: started.elapsed().as_nanos() as f64,
                    scanned_departures: 0,
                    excluded_departures: 0,
                    relaxed_stops: stats.relaxed_stops,
                    expanded_trip_runs: 0,
                    dominated_trip_boardings: 0,
                    explicit_transfer_checks: stats.explicit_transfer_checks,
                },
                overlay_connections: compiled.events.len() as u32,
                overlay_runs: compiled.run_count as u32,
                supplemental_transfer_edges: supplemental_transfer_edges.len() as u32,
                compile_ns,
                scan_ns: scan_started.elapsed().as_nanos() as f64,
                transient_bytes: transient_bytes as f64,
                workspace_bytes,
            });
        }

        let mut base_time_index = scan_time_lower_bound(scan_times, input.departure);
        let mut overlay_index = compiled
            .events
            .partition_point(|event| f64::from(event.departure) < input.departure);
        while base_time_index < scan_times.len() || overlay_index < compiled.events.len() {
            let base_departure = scan_times.get(base_time_index).copied().unwrap_or(u32::MAX);
            let overlay_departure = compiled
                .events
                .get(overlay_index)
                .map(|event| event.departure)
                .unwrap_or(u32::MAX);
            let connection_departure = base_departure.min(overlay_departure);
            if f64::from(connection_departure) > input.horizon {
                break;
            }

            let base_bucket_start = base_time_index;
            let overlay_bucket_start = overlay_index;
            let needs_closure = (base_departure == connection_departure
                && scan_time_needs_closure
                    .get(base_time_index)
                    .copied()
                    .unwrap_or(false))
                || compiled.events[overlay_index..]
                    .iter()
                    .take_while(|event| event.departure == connection_departure)
                    .any(|event| event.arrival == connection_departure);
            loop {
                let previous_changes = (stats.relaxed_stops, stats.expanded_trip_runs);
                base_time_index = base_bucket_start;
                overlay_index = overlay_bucket_start;
                if base_departure == connection_departure && base_time_index < scan_times.len() {
                    let start = scan_time_offsets[base_time_index] as usize;
                    let end = scan_time_offsets[base_time_index + 1] as usize;
                    for connection in start..end {
                        for layer in first_layer..=maximum_layer {
                            let input_offset = layer.saturating_sub(1) * combined_stop_count;
                            let output_offset = layer * combined_stop_count;
                            let event = scan_events[connection];
                            let flags = event.flags();
                            let base_stop = event.source_stop();
                            let stop = input_offset + base_stop;
                            let run = layer * combined_run_count + event.run();
                            stats.scanned_departures = stats.scanned_departures.saturating_add(1);
                            let trip = scan_journeys[connection].trip as usize;
                            if many_workspace.excluded_trip_generation[trip] == epoch {
                                excluded_departures = excluded_departures.saturating_add(1);
                                continue;
                            }
                            let mut boarding_state = NO_STATE;
                            if flags & SCAN_CAN_BOARD != 0
                                && many_workspace.stop_generation[stop] == epoch
                                && many_workspace.active_state_mask[stop] != 0
                            {
                                let mut active_states = many_workspace.active_state_mask[stop];
                                while active_states != 0 {
                                    let state_flags = active_states.trailing_zeros() as usize;
                                    active_states &= active_states - 1;
                                    let has_ride = state_flags & 4 != 0;
                                    if has_ride && forbidden_same_stop[base_stop] == 1 {
                                        continue;
                                    }
                                    let state = stop * STATE_STRIDE + state_flags;
                                    if boarding_ready_time(
                                        many_workspace.labels[state],
                                        has_ride,
                                        state_flags & 1 != 0,
                                        same_stop_transfer_minimum[base_stop],
                                    ) <= f64::from(connection_departure)
                                    {
                                        boarding_state = state as i32;
                                        break;
                                    }
                                }
                            }
                            if boarding_state >= 0 {
                                if many_workspace.run_generation[run] != epoch
                                    || (connection as u32)
                                        < many_workspace.run_boarding_connection[run]
                                {
                                    many_workspace.run_generation[run] = epoch;
                                    many_workspace.run_boarding_connection[run] = connection as u32;
                                    many_workspace.run_boarding_state[run] = boarding_state;
                                    stats.expanded_trip_runs =
                                        stats.expanded_trip_runs.saturating_add(1);
                                } else {
                                    stats.dominated_trip_boardings =
                                        stats.dominated_trip_boardings.saturating_add(1);
                                }
                            }
                            if many_workspace.run_generation[run] != epoch {
                                continue;
                            }
                            let boarding = many_workspace.run_boarding_connection[run] as usize;
                            if connection < boarding {
                                continue;
                            }
                            let predecessor = many_workspace.run_boarding_state[run];
                            let board_sequence = scan_journeys[boarding].sequence as f64;
                            let trip = scan_journeys[connection].trip as i32;
                            if connection > boarding && flags & SCAN_BRIDGE_EXIT != 0 {
                                let bridge_stop = output_offset + event.source_stop();
                                let bridge_state = relax_many_record(
                                    many_workspace,
                                    epoch,
                                    &mut stats,
                                    bridge_stop,
                                    f64::from(connection_departure),
                                    true,
                                    true,
                                    true,
                                    input.horizon,
                                    false,
                                    predecessor,
                                    2,
                                    trip,
                                    board_sequence,
                                    scan_journeys[connection].prior_sequence as f64 + 0.5,
                                    0,
                                );
                                if bridge_state >= 0 {
                                    expand_many_combined_transfer_edges_chain(
                                        many_workspace,
                                        epoch,
                                        &mut stats,
                                        base_stop_count,
                                        transfer_offset,
                                        transfer_edges,
                                        &input.supplemental_transfer_offsets,
                                        &supplemental_transfer_edges,
                                        bridge_stop,
                                        f64::from(connection_departure),
                                        true,
                                        input.horizon,
                                        bridge_state,
                                    );
                                }
                            }
                            let arrival = scan_arrivals[connection];
                            if flags & SCAN_CAN_ALIGHT == 0
                                || f64::from(arrival.arrival) > input.horizon
                            {
                                continue;
                            }
                            let alight_stop = output_offset + arrival.to as usize;
                            let alight_state = relax_many_record(
                                many_workspace,
                                epoch,
                                &mut stats,
                                alight_stop,
                                f64::from(arrival.arrival),
                                true,
                                true,
                                true,
                                input.horizon,
                                false,
                                predecessor,
                                2,
                                trip,
                                board_sequence,
                                scan_journeys[connection].sequence as f64,
                                0,
                            );
                            if alight_state >= 0 {
                                expand_many_combined_transfer_edges_chain(
                                    many_workspace,
                                    epoch,
                                    &mut stats,
                                    base_stop_count,
                                    transfer_offset,
                                    transfer_edges,
                                    &input.supplemental_transfer_offsets,
                                    &supplemental_transfer_edges,
                                    alight_stop,
                                    f64::from(arrival.arrival),
                                    true,
                                    input.horizon,
                                    alight_state,
                                );
                            }
                        }
                    }
                    base_time_index += 1;
                }

                while overlay_index < compiled.events.len()
                    && compiled.events[overlay_index].departure == connection_departure
                {
                    let event = compiled.events[overlay_index];
                    for layer in first_layer..=maximum_layer {
                        let input_stop = layer.saturating_sub(1) * combined_stop_count + event.from;
                        let output_stop = layer * combined_stop_count + event.to;
                        let run = layer * combined_run_count + base_run_count + event.run;
                        stats.scanned_departures = stats.scanned_departures.saturating_add(1);
                        let mut boarding_state = NO_STATE;
                        if event.can_board
                            && many_workspace.stop_generation[input_stop] == epoch
                            && many_workspace.active_state_mask[input_stop] != 0
                        {
                            let mut active_states = many_workspace.active_state_mask[input_stop];
                            while active_states != 0 {
                                let state_flags = active_states.trailing_zeros() as usize;
                                active_states &= active_states - 1;
                                let has_ride = state_flags & 4 != 0;
                                let state = input_stop * STATE_STRIDE + state_flags;
                                if boarding_ready_time(
                                    many_workspace.labels[state],
                                    has_ride,
                                    state_flags & 1 != 0,
                                    same_stop_transfer_minimum
                                        .get(event.from)
                                        .copied()
                                        .unwrap_or(0),
                                ) <= f64::from(event.departure)
                                {
                                    boarding_state = state as i32;
                                    break;
                                }
                            }
                        }
                        if boarding_state >= 0 {
                            if many_workspace.run_generation[run] != epoch
                                || (overlay_index as u32)
                                    < many_workspace.run_boarding_connection[run]
                            {
                                many_workspace.run_generation[run] = epoch;
                                many_workspace.run_boarding_connection[run] = overlay_index as u32;
                                many_workspace.run_boarding_state[run] = boarding_state;
                                stats.expanded_trip_runs =
                                    stats.expanded_trip_runs.saturating_add(1);
                            } else {
                                stats.dominated_trip_boardings =
                                    stats.dominated_trip_boardings.saturating_add(1);
                            }
                        }
                        if many_workspace.run_generation[run] == epoch
                            && overlay_index >= many_workspace.run_boarding_connection[run] as usize
                            && event.can_alight
                            && f64::from(event.arrival) <= input.horizon
                        {
                            let boarding = many_workspace.run_boarding_connection[run] as usize;
                            let predecessor = many_workspace.run_boarding_state[run];
                            let boarding_event = compiled.events[boarding];
                            let overlay_trip = -(event.run as i32) - 2;
                            let alight_state = relax_many_record(
                                many_workspace,
                                epoch,
                                &mut stats,
                                output_stop,
                                f64::from(event.arrival),
                                true,
                                true,
                                true,
                                input.horizon,
                                false,
                                predecessor,
                                2,
                                overlay_trip,
                                boarding_event.sequence as f64,
                                event.sequence as f64,
                                0,
                            );
                            if alight_state >= 0 {
                                expand_many_combined_transfer_edges_chain(
                                    many_workspace,
                                    epoch,
                                    &mut stats,
                                    base_stop_count,
                                    transfer_offset,
                                    transfer_edges,
                                    &input.supplemental_transfer_offsets,
                                    &supplemental_transfer_edges,
                                    output_stop,
                                    f64::from(event.arrival),
                                    true,
                                    input.horizon,
                                    alight_state,
                                );
                            }
                        }
                    }
                    overlay_index += 1;
                }
                if !needs_closure
                    || previous_changes == (stats.relaxed_stops, stats.expanded_trip_runs)
                {
                    break;
                }
            }
        }

        let mut best_arrivals = vec![f64::INFINITY; destination_count];
        let mut best_state = NO_STATE;
        let mut best_destination_index = NO_STATE;
        let mut best_overall_arrival = f64::INFINITY;
        for (destination, best) in best_arrivals.iter_mut().enumerate() {
            let start = input.destination_offsets[destination] as usize;
            let end = input.destination_offsets[destination + 1] as usize;
            for seed in start..end {
                for layer in first_layer..=maximum_layer {
                    let stop = layer * combined_stop_count + input.destination_stops[seed] as usize;
                    for flags in [6_usize, 7] {
                        if flags == 6
                            && input
                                .allow_post_ride_transfers
                                .as_ref()
                                .is_some_and(|allowed| !allowed[destination])
                        {
                            continue;
                        }
                        let state = stop * STATE_STRIDE + flags;
                        if many_workspace.state_generation[state] != epoch {
                            continue;
                        }
                        let arrival =
                            many_workspace.labels[state] + input.destination_walk_seconds[seed];
                        if arrival < *best {
                            *best = arrival;
                        }
                        let candidate_index = destination_candidate_indices
                            .and_then(|indices| indices.get(seed).copied())
                            .unwrap_or(seed as u32)
                            as i32;
                        if arrival < best_overall_arrival
                            || (arrival == best_overall_arrival
                                && (best_destination_index < 0
                                    || candidate_index < best_destination_index))
                        {
                            best_overall_arrival = arrival;
                            best_state = state as i32;
                            best_destination_index = candidate_index;
                        }
                    }
                }
            }
        }
        let mut chain = Vec::<JourneyChainStep>::new();
        if best_state >= 0 {
            let mut state = best_state;
            while state >= 0 {
                let state_index = state as usize;
                let predecessor_record = many_workspace.predecessors[state_index];
                let stop = ((state_index / STATE_STRIDE) % combined_stop_count) as i32;
                if predecessor_record.kind == 3 {
                    chain.push((
                        3,
                        NO_STATE,
                        stop,
                        predecessor_record.trip,
                        0.0,
                        0.0,
                        predecessor_record.duration,
                        many_workspace.labels[state_index],
                    ));
                    break;
                }
                let predecessor = predecessor_record.state;
                if predecessor < 0 {
                    break;
                }
                chain.push((
                    predecessor_record.kind as u32,
                    ((predecessor as usize / STATE_STRIDE) % combined_stop_count) as i32,
                    stop,
                    predecessor_record.trip,
                    f64::from(predecessor_record.board_sequence_twice) * 0.5,
                    f64::from(predecessor_record.alight_sequence_twice) * 0.5,
                    predecessor_record.duration,
                    many_workspace.labels[state_index],
                ));
                state = predecessor;
            }
            chain.reverse();
        }
        let workspace_bytes = many_workspace.byte_length() as f64;
        many_workspace.predecessors = Vec::new();
        many_workspace.run_boarding_state = Vec::new();
        Ok(TimetableOverlayManyQueryResult {
            timetable: TimetableManyQueryResult {
                supported: true,
                status: "complete".to_owned(),
                reason: None,
                algorithm: "rust_resident_query_overlay_connection_scan_one_to_many".to_owned(),
                best_arrivals,
                best_destination_index: (best_destination_index >= 0)
                    .then_some(best_destination_index as u32),
                chain_kinds: chain.iter().map(|step| step.0).collect(),
                chain_from_stops: chain.iter().map(|step| step.1).collect(),
                chain_to_stops: chain.iter().map(|step| step.2).collect(),
                chain_trip_or_candidate: chain.iter().map(|step| step.3).collect(),
                chain_board_sequences: chain.iter().map(|step| step.4).collect(),
                chain_alight_sequences: chain.iter().map(|step| step.5).collect(),
                chain_durations: chain.iter().map(|step| step.6).collect(),
                chain_arrivals: chain.iter().map(|step| step.7).collect(),
                query_ns: started.elapsed().as_nanos() as f64,
                scanned_departures: stats.scanned_departures,
                excluded_departures,
                relaxed_stops: stats.relaxed_stops,
                expanded_trip_runs: stats.expanded_trip_runs,
                dominated_trip_boardings: stats.dominated_trip_boardings,
                explicit_transfer_checks: stats.explicit_transfer_checks,
            },
            overlay_connections: compiled.events.len() as u32,
            overlay_runs: compiled.run_count as u32,
            supplemental_transfer_edges: supplemental_transfer_edges.len() as u32,
            compile_ns,
            scan_ns: scan_started.elapsed().as_nanos() as f64,
            transient_bytes: transient_bytes as f64,
            workspace_bytes,
        })
    }

    #[napi]
    pub fn route_pareto_round_csa(
        &mut self,
        input: TimetableParetoQueryInput,
    ) -> napi::Result<TimetableParetoQueryResult> {
        let started = Instant::now();
        let restriction_mode = ParetoRestrictionMode::parse(input.restriction_mode.as_deref())?;
        if input.origin_stops.len() != input.origin_walk_seconds.len()
            || input.origin_stops.len() != input.origin_candidate_indices.len()
            || input.destination_stops.len() != input.destination_walk_seconds.len()
            || input.destination_stops.len() != input.destination_candidate_indices.len()
            || input
                .origin_stops
                .iter()
                .chain(input.destination_stops.iter())
                .any(|stop| *stop as usize >= self.stop_count)
            || input
                .origin_walk_seconds
                .iter()
                .chain(input.destination_walk_seconds.iter())
                .any(|seconds| !seconds.is_finite() || *seconds < 0.0)
            || !input.departure.is_finite()
            || !input.horizon.is_finite()
            || !input.earliest_arrival.is_finite()
            || !input.candidate_walking_seconds.is_finite()
            || !input.arrival_slack_seconds.is_finite()
            || !input.transfer_penalty_seconds.is_finite()
            || !input.walk_reluctance.is_finite()
            || input.departure < 0.0
            || input.horizon < input.departure
            || input.earliest_arrival < input.departure
            || input.candidate_walking_seconds < 0.0
            || input.arrival_slack_seconds < 0.0
            || input.transfer_penalty_seconds < 0.0
            || input.walk_reluctance < 0.0
            || input.boarding_upper_bound == 0
            || input.boarding_upper_bound as usize > MAX_PROFILE_BOARDINGS
        {
            return Err(Error::from_reason(
                "Rust round timetable query arrays or bounds are inconsistent.",
            ));
        }
        let Self {
            stop_count,
            run_count,
            departure_seconds,
            arrival_seconds,
            from_stop,
            to_stop,
            sequence,
            segment_trip,
            segment_run,
            continuity_break,
            can_board,
            can_alight,
            trip_start: _,
            departure_offset,
            departure_events,
            transfer_offset,
            transfer_edges,
            forbidden_same_stop,
            same_stop_transfer_minimum,
            scan_events,
            scan_times,
            scan_time_offsets,
            scan_time_needs_closure: _,
            scan_arrivals,
            scan_journeys: _,
            run_start,
            run_end,
            reverse_transfer_offset,
            reverse_transfer_edges,
            exit_event_offset,
            exit_events,
            workspace: destination_workspace,
            many_workspace: _,
            forward_workspace,
            profile_workspace,
        } = self;
        let destination_epoch = destination_workspace.begin_query();
        destination_workspace.allow_post_ride_transfers =
            input.allow_post_ride_transfers.unwrap_or(true);
        let mut destination_seeds = 0_u32;
        for index in 0..input.destination_stops.len() {
            let stop = input.destination_stops[index] as usize;
            let walk_seconds = input.destination_walk_seconds[index];
            if destination_workspace.destination_generation[stop] != destination_epoch {
                destination_workspace.destination_generation[stop] = destination_epoch;
                destination_workspace.destination_egress[stop] = walk_seconds;
                destination_workspace.destination_candidate[stop] =
                    input.destination_candidate_indices[index] as i32;
                destination_seeds = destination_seeds.saturating_add(1);
            } else if walk_seconds < destination_workspace.destination_egress[stop] {
                destination_workspace.destination_egress[stop] = walk_seconds;
                destination_workspace.destination_candidate[stop] =
                    input.destination_candidate_indices[index] as i32;
            }
        }
        if destination_seeds == 0 {
            return Ok(empty_pareto_result(
                started,
                false,
                "destination_outside_kernel",
                restriction_mode,
            ));
        }
        let boarding_upper_bound = input.boarding_upper_bound as u16;
        let origin_epoch = profile_workspace.begin_query();
        // The horizon bounds connection departures, not the final arrival after
        // an in-vehicle segment or destination egress. The scalar witness may
        // therefore arrive beyond the horizon and must remain inside the exact
        // Pareto corridor.
        let arrival_upper_bound = input.earliest_arrival + input.arrival_slack_seconds.max(0.0);
        let transfer_penalty_seconds = input.transfer_penalty_seconds.max(0.0);
        let walk_reluctance = input.walk_reluctance.max(0.0);
        let collect_alternatives = input.collect_alternatives.unwrap_or(false);
        let deadline_objective = input.deadline_objective.unwrap_or(false);
        let generalized_upper_bound = generalized_seconds(
            input.earliest_arrival,
            boarding_upper_bound,
            input.candidate_walking_seconds,
            transfer_penalty_seconds,
            walk_reluctance,
        );
        let corridor_started = Instant::now();
        let forward_started = Instant::now();
        let scalar_envelope_reused = restriction_mode.uses_forward()
            && forward_workspace
                .scalar_identity
                .as_ref()
                .is_some_and(|identity| identity.matches(&input));
        let forward_envelope_built = restriction_mode.uses_forward() && !scalar_envelope_reused;
        let forward_envelope = if !restriction_mode.uses_forward() {
            ForwardRunEnvelope::default()
        } else if scalar_envelope_reused {
            let mut envelope = ForwardRunEnvelope::default();
            // Egress can stop the scalar scan before its final arrival time.
            // Resume at the first unscanned bucket, including that interval.
            let mut time_index = forward_workspace
                .scalar_identity
                .as_ref()
                .unwrap()
                .next_scan_time_index;
            while time_index < scan_times.len() {
                if scan_times[time_index] as f64 > arrival_upper_bound {
                    break;
                }
                let start = scan_time_offsets[time_index] as usize;
                let end = scan_time_offsets[time_index + 1] as usize;
                envelope.departure_events_scanned += (end - start) as u64;
                for event in &scan_events[start..end] {
                    set_run_bit(&mut forward_workspace.scalar_runs, event.run());
                }
                time_index += 1;
            }
            envelope
        } else {
            forward_workspace.scalar_runs.fill(0);
            build_forward_run_envelope_csa(
                forward_workspace,
                *stop_count,
                *run_count,
                boarding_upper_bound as usize,
                &input.origin_stops,
                &input.origin_walk_seconds,
                input.departure,
                arrival_upper_bound,
                input.allow_pre_ride_transfers,
                scan_events,
                scan_times,
                scan_time_offsets,
                scan_arrivals,
                transfer_offset,
                transfer_edges,
            )
        };
        forward_workspace.scalar_identity = None;
        let forward_ns = if restriction_mode.uses_forward() {
            forward_started.elapsed().as_nanos() as f64
        } else {
            0.0
        };
        let reverse_started = Instant::now();
        let forward_run_layers = if restriction_mode.uses_forward() && !scalar_envelope_reused {
            Some(&forward_workspace.run_layers[..boarding_upper_bound as usize])
        } else {
            None
        };
        let corridor = if restriction_mode.uses_reverse() {
            build_exact_deadline_corridor(
                *stop_count,
                *run_count,
                boarding_upper_bound as usize,
                restriction_mode.uses_forward(),
                forward_run_layers,
                &forward_workspace.scalar_runs,
                &input.destination_stops,
                &input.destination_walk_seconds,
                departure_seconds,
                from_stop,
                can_board,
                run_start,
                reverse_transfer_offset,
                reverse_transfer_edges,
                exit_event_offset,
                exit_events,
                input.departure,
                arrival_upper_bound,
                if collect_alternatives || deadline_objective {
                    f64::INFINITY
                } else {
                    generalized_upper_bound
                },
                transfer_penalty_seconds,
                walk_reluctance,
            )
        } else {
            build_open_deadline_corridor(
                *stop_count,
                *run_count,
                boarding_upper_bound as usize,
                restriction_mode.uses_forward(),
                forward_run_layers,
                &forward_workspace.scalar_runs,
            )
        };
        let reverse_ns = if restriction_mode.uses_reverse() {
            reverse_started.elapsed().as_nanos() as f64
        } else {
            0.0
        };
        let corridor_ns = corridor_started.elapsed().as_nanos() as f64;
        let corridor_structure = corridor_structure_stats(&corridor, run_start, run_end);
        let mut best = ParetoBest {
            deadline_objective,
            arrival: input.earliest_arrival,
            boardings: boarding_upper_bound,
            walking_seconds: input.candidate_walking_seconds,
            generalized_seconds: generalized_upper_bound,
            label: NO_STATE,
            destination_index: input.candidate_destination_index as i32,
            collect_alternatives,
            minimum_arrival: input.earliest_arrival,
            // Keep the anchor-only expansion as an independent reference for
            // both corridor and target-dominance pruning.
            prune_dominated_alternatives: collect_alternatives
                && restriction_mode != ParetoRestrictionMode::Only,
            // Extra arrival slack permits longer final rides or egress, not
            // boarding connections outside the original query horizon.
            departure_upper_bound: if collect_alternatives {
                input.horizon
            } else {
                f64::INFINITY
            },
        };
        let mut stats = ParetoStats {
            terminal_candidates_evaluated: 1,
            ..ParetoStats::default()
        };
        for index in 0..input.origin_stops.len() {
            let stop = input.origin_stops[index] as usize;
            let arrival = input.departure + input.origin_walk_seconds[index];
            if !deadline_allows(
                corridor.stop_deadlines[boarding_upper_bound as usize][stop],
                arrival,
            ) {
                continue;
            }
            add_round_label(
                profile_workspace,
                origin_epoch,
                destination_workspace,
                destination_epoch,
                &mut best,
                &mut stats,
                stop,
                arrival,
                false,
                false,
                false,
                NO_STATE,
                3,
                input.origin_candidate_indices[index] as i32,
                0.0,
                0.0,
                input.origin_walk_seconds[index].max(0.0).round() as u32,
                arrival_upper_bound,
                boarding_upper_bound,
                transfer_penalty_seconds,
                walk_reluctance,
            );
        }
        if input.allow_pre_ride_transfers {
            let origin_label_end = profile_workspace.labels.len();
            for index in 0..origin_label_end {
                if !profile_workspace.labels[index].active
                    || profile_workspace.labels[index].kind != 3
                {
                    continue;
                }
                let stop = profile_workspace.labels[index].state as usize / STATE_STRIDE;
                expand_round_transfers(
                    profile_workspace,
                    origin_epoch,
                    destination_workspace,
                    destination_epoch,
                    &mut best,
                    &mut stats,
                    transfer_offset,
                    transfer_edges,
                    &corridor.stop_deadlines[boarding_upper_bound as usize],
                    stop,
                    profile_workspace.labels[index].arrival,
                    false,
                    index as i32,
                    arrival_upper_bound,
                    boarding_upper_bound,
                    transfer_penalty_seconds,
                    walk_reluctance,
                );
            }
        }
        let mut previous_labels: Vec<i32> = (0..profile_workspace.labels.len())
            .filter(|index| profile_workspace.labels[*index].active)
            .map(|index| index as i32)
            .collect();
        if previous_labels.is_empty() {
            return Ok(empty_pareto_result(
                started,
                false,
                "origin_outside_kernel",
                restriction_mode,
            ));
        }

        let rounds_started = Instant::now();
        for round in 1..=boarding_upper_bound {
            let epoch = profile_workspace.next_round();
            let remaining = (boarding_upper_bound - round) as usize;
            previous_labels = execute_marked_run_round(
                profile_workspace,
                epoch,
                &mut previous_labels,
                round,
                destination_workspace,
                destination_epoch,
                &mut best,
                &mut stats,
                departure_seconds,
                arrival_seconds,
                from_stop,
                to_stop,
                sequence,
                segment_trip,
                segment_run,
                continuity_break,
                can_board,
                can_alight,
                departure_offset,
                departure_events,
                transfer_offset,
                transfer_edges,
                forbidden_same_stop,
                same_stop_transfer_minimum,
                run_start,
                run_end,
                &corridor.stop_deadlines[remaining],
                &corridor.run_layers[remaining],
                arrival_upper_bound,
                boarding_upper_bound,
                transfer_penalty_seconds,
                walk_reluctance,
            );
            // Rounds enumerate exact boarding counts. Once a deadline-feasible
            // round is exhausted, extra boardings cannot improve this objective.
            if (deadline_objective && round >= best.boardings)
                || profile_workspace.overflowed
                || previous_labels.is_empty()
            {
                break;
            }
        }
        let round_ns = rounds_started.elapsed().as_nanos() as f64;
        if profile_workspace.overflowed {
            return Ok(empty_pareto_result(
                started,
                false,
                "native_round_workspace_budget_exceeded",
                restriction_mode,
            ));
        }
        let alternatives = collect_alternatives.then(|| {
            collect_pareto_alternatives(
                &profile_workspace.labels,
                destination_workspace,
                destination_epoch,
                arrival_upper_bound,
            )
        });
        let result = |chain: Vec<JourneyChainStep>,
                      improved_candidate: bool|
         -> TimetableParetoQueryResult {
            TimetableParetoQueryResult {
                supported: true,
                status: "ready".to_owned(),
                reason: None,
                best_arrival: Some(best.arrival),
                best_boardings: Some(best.boardings as u32),
                best_destination_index: Some(best.destination_index as u32),
                best_walking_seconds: Some(best.walking_seconds),
                best_generalized_seconds: Some(best.generalized_seconds),
                improved_candidate,
                alternatives,
                chain_kinds: chain.iter().map(|step| step.0).collect(),
                chain_from_stops: chain.iter().map(|step| step.1).collect(),
                chain_to_stops: chain.iter().map(|step| step.2).collect(),
                chain_trip_or_candidate: chain.iter().map(|step| step.3).collect(),
                chain_board_sequences: chain.iter().map(|step| step.4).collect(),
                chain_alight_sequences: chain.iter().map(|step| step.5).collect(),
                chain_durations: chain.iter().map(|step| step.6).collect(),
                chain_arrivals: chain.iter().map(|step| step.7).collect(),
                query_ns: started.elapsed().as_nanos() as f64,
                corridor_ns,
                forward_ns,
                reverse_ns,
                round_ns,
                corridor_exit_events: corridor.exit_events_scanned as f64,
                corridor_run_segments: corridor.run_segments_scanned as f64,
                corridor_transfer_edges: corridor.transfer_edges_scanned as f64,
                forward_departure_events: forward_envelope.departure_events_scanned as f64,
                forward_run_segments: forward_envelope.run_segments_scanned as f64,
                forward_transfer_edges: forward_envelope.transfer_edges_scanned as f64,
                scanned_departures: stats.scanned_departures,
                relaxed_stops: stats.relaxed_stops,
                expanded_trip_runs: stats.expanded_trip_runs,
                dominated_trip_boardings: stats.dominated_trip_boardings,
                explicit_transfer_checks: stats.explicit_transfer_checks,
                dominated_candidate_labels: stats.dominated_candidate_labels,
                dominated_existing_labels: stats.dominated_existing_labels,
                terminal_candidates_evaluated: stats.terminal_candidates_evaluated,
                pareto_labels: profile_workspace.labels.len() as u32,
                run_profiles: stats.expanded_trip_runs,
                restriction_mode: restriction_mode.as_str().to_owned(),
                forward_restriction_applied: restriction_mode.uses_forward(),
                reverse_restriction_applied: restriction_mode.uses_reverse(),
                scalar_envelope_reused,
                forward_envelope_built,
                reverse_corridor_built: restriction_mode.uses_reverse(),
                retained_run_layer_memberships: corridor_structure.retained_run_layer_memberships
                    as f64,
                total_run_layer_memberships: corridor_structure.total_run_layer_memberships as f64,
                retained_segment_layer_memberships: corridor_structure
                    .retained_segment_layer_memberships
                    as f64,
                total_segment_layer_memberships: corridor_structure.total_segment_layer_memberships
                    as f64,
                retained_stop_deadline_memberships: corridor_structure
                    .retained_stop_deadline_memberships
                    as f64,
                total_stop_deadline_memberships: corridor_structure.total_stop_deadline_memberships
                    as f64,
                retained_unique_runs: corridor_structure.retained_unique_runs,
                restriction_bytes: corridor_structure.restriction_bytes as f64,
                label_bytes: (profile_workspace.labels.len() * std::mem::size_of::<ProfileLabel>())
                    as f64,
            }
        };
        if best.label < 0 {
            return Ok(result(Vec::new(), false));
        }
        let chain = profile_label_chain(&profile_workspace.labels, best.label);
        Ok(result(chain, true))
    }

    #[napi]
    pub fn diagnostics(&self) -> TimetableKernelDiagnostics {
        let source_array_bytes = self.departure_seconds.len() * std::mem::size_of::<u32>()
            + self.arrival_seconds.len() * std::mem::size_of::<u32>()
            + self.from_stop.len() * std::mem::size_of::<u32>()
            + self.to_stop.len() * std::mem::size_of::<u32>()
            + self.sequence.len() * std::mem::size_of::<u32>()
            + self.segment_trip.len() * std::mem::size_of::<u32>()
            + self.segment_run.len() * std::mem::size_of::<u32>()
            + self.continuity_break.len() * std::mem::size_of::<u8>()
            + self.can_board.len() * std::mem::size_of::<u8>()
            + self.can_alight.len() * std::mem::size_of::<u8>()
            + self.trip_start.len() * std::mem::size_of::<u32>()
            + self.forbidden_same_stop.len() * std::mem::size_of::<u8>()
            + self.same_stop_transfer_minimum.len() * std::mem::size_of::<u32>();
        let native_index_bytes = self.departure_events.len()
            * std::mem::size_of::<DepartureEvent>()
            + self.departure_offset.len() * std::mem::size_of::<u32>()
            + self.transfer_edges.len() * std::mem::size_of::<TransferEdge>()
            + self.transfer_offset.len() * std::mem::size_of::<u32>()
            + self.scan_events.len() * std::mem::size_of::<ScanEvent>()
            + self.scan_times.len() * std::mem::size_of::<u32>()
            + self.scan_time_offsets.len() * std::mem::size_of::<u32>()
            + self.scan_time_needs_closure.len() * std::mem::size_of::<bool>()
            + self.scan_arrivals.len() * std::mem::size_of::<ScanArrival>()
            + self.scan_journeys.len() * std::mem::size_of::<ScanJourney>()
            + self.run_start.len() * std::mem::size_of::<u32>()
            + self.run_end.len() * std::mem::size_of::<u32>()
            + self.reverse_transfer_offset.len() * std::mem::size_of::<u32>()
            + self.reverse_transfer_edges.len() * std::mem::size_of::<TransferEdge>()
            + self.exit_event_offset.len() * std::mem::size_of::<u32>()
            + self.exit_events.len() * std::mem::size_of::<ExitEvent>();
        let array_bytes = source_array_bytes + native_index_bytes;
        TimetableKernelDiagnostics {
            stop_count: self.stop_count as u32,
            state_count: (self.stop_count * STATE_STRIDE) as u32,
            segment_count: self.departure_seconds.len() as u32,
            trip_count: self.trip_start.len().saturating_sub(1) as u32,
            run_count: self.run_count as u32,
            transfer_count: self.transfer_edges.len() as u32,
            transfer_board_slack_seconds: TRANSFER_BOARD_SLACK_SECONDS,
            workspace_bytes: (self.workspace.byte_length()
                + self.many_workspace.byte_length()
                + self.forward_workspace.byte_length()
                + self.profile_workspace.byte_length()) as f64,
            source_array_bytes: source_array_bytes as f64,
            native_index_bytes: native_index_bytes as f64,
            array_bytes: array_bytes as f64,
            zero_copy_arrays: true,
            algorithm: "exact_connection_scan_no_heuristic".to_owned(),
        }
    }
}

fn boarding_layers(maximum: Option<u32>) -> napi::Result<usize> {
    match maximum {
        Some(value) if value == 0 || value as usize > MAX_PROFILE_BOARDINGS => Err(
            Error::from_reason("maximumBoardings must be between 1 and 32."),
        ),
        Some(value) => Ok(value as usize),
        None => Ok(0),
    }
}

fn empty_result(started: Instant, supported: bool, reason: &str) -> TimetableQueryResult {
    TimetableQueryResult {
        supported,
        status: "unsupported".to_owned(),
        reason: Some(reason.to_owned()),
        best_arrival: None,
        best_boardings: None,
        best_destination_index: None,
        chain_kinds: Vec::new(),
        chain_from_stops: Vec::new(),
        chain_to_stops: Vec::new(),
        chain_trip_or_candidate: Vec::new(),
        chain_board_sequences: Vec::new(),
        chain_alight_sequences: Vec::new(),
        chain_durations: Vec::new(),
        chain_arrivals: Vec::new(),
        query_ns: started.elapsed().as_nanos() as f64,
        destination_seed_ns: 0.0,
        origin_seed_ns: 0.0,
        scan_ns: 0.0,
        chain_ns: 0.0,
        popped_states: 0,
        scanned_departures: 0,
        relaxed_stops: 0,
        expanded_trip_runs: 0,
        dominated_trip_boardings: 0,
        explicit_transfer_checks: 0,
    }
}

fn empty_pareto_result(
    started: Instant,
    supported: bool,
    reason: &str,
    restriction_mode: ParetoRestrictionMode,
) -> TimetableParetoQueryResult {
    TimetableParetoQueryResult {
        supported,
        status: "unsupported".to_owned(),
        reason: Some(reason.to_owned()),
        best_arrival: None,
        best_boardings: None,
        best_destination_index: None,
        best_walking_seconds: None,
        best_generalized_seconds: None,
        improved_candidate: false,
        alternatives: None,
        chain_kinds: Vec::new(),
        chain_from_stops: Vec::new(),
        chain_to_stops: Vec::new(),
        chain_trip_or_candidate: Vec::new(),
        chain_board_sequences: Vec::new(),
        chain_alight_sequences: Vec::new(),
        chain_durations: Vec::new(),
        chain_arrivals: Vec::new(),
        query_ns: started.elapsed().as_nanos() as f64,
        corridor_ns: 0.0,
        forward_ns: 0.0,
        reverse_ns: 0.0,
        round_ns: 0.0,
        corridor_exit_events: 0.0,
        corridor_run_segments: 0.0,
        corridor_transfer_edges: 0.0,
        forward_departure_events: 0.0,
        forward_run_segments: 0.0,
        forward_transfer_edges: 0.0,
        scanned_departures: 0,
        relaxed_stops: 0,
        expanded_trip_runs: 0,
        dominated_trip_boardings: 0,
        explicit_transfer_checks: 0,
        dominated_candidate_labels: 0,
        dominated_existing_labels: 0,
        terminal_candidates_evaluated: 0,
        pareto_labels: 0,
        run_profiles: 0,
        restriction_mode: restriction_mode.as_str().to_owned(),
        forward_restriction_applied: restriction_mode.uses_forward(),
        reverse_restriction_applied: restriction_mode.uses_reverse(),
        scalar_envelope_reused: false,
        forward_envelope_built: false,
        reverse_corridor_built: false,
        retained_run_layer_memberships: 0.0,
        total_run_layer_memberships: 0.0,
        retained_segment_layer_memberships: 0.0,
        total_segment_layer_memberships: 0.0,
        retained_stop_deadline_memberships: 0.0,
        total_stop_deadline_memberships: 0.0,
        retained_unique_runs: 0,
        restriction_bytes: 0.0,
        label_bytes: 0.0,
    }
}
