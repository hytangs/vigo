mod columns;
pub use columns::TimetableBlockPool;
type SourceU32 = columns::Column<u32>;
type SourceU8 = columns::Column<u8>;
use crate::types::*;
use std::collections::HashMap;
use std::time::Instant;

mod station_access_validation;
pub use station_access_validation::*;

mod station_access;
pub use station_access::*;

mod realtime;
pub use realtime::*;
mod scenario;
pub use scenario::*;

mod preparation;
pub use preparation::*;
mod transfer_paths;
pub use transfer_paths::*;

mod journeys;
mod shared_legs;
pub use shared_legs::*;
mod overlay_quality;
pub use journeys::{TimetableMatrixJourney, TimetableMatrixLeg};

const STATE_STRIDE: usize = 8;
const NO_STATE: i32 = -1;

#[derive(Clone, Copy)]
struct ScalarRunBoarding {
    connection: i32,
    predecessor: i32,
    sequence: u32,
    boardings: u16,
}

/// Multiplicative hashing for dense run indices. A probed-only map needs no
/// DoS-resistant hash, and the high bits must vary for hashbrown's tags.
#[derive(Default)]
struct RunHasher(u64);

impl std::hash::Hasher for RunHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = (self.0.rotate_left(8) ^ u64::from(byte)).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        }
    }

    fn write_usize(&mut self, value: usize) {
        self.0 = (value as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
}

type RunMap<V> = HashMap<usize, V, std::hash::BuildHasherDefault<RunHasher>>;

fn retain_scalar_bucket_boarding(
    profiles: &mut RunMap<Vec<ScalarRunBoarding>>,
    run: usize,
    candidate: ScalarRunBoarding,
) -> bool {
    let frontier = profiles.entry(run).or_default();
    if frontier
        .iter()
        .any(|old| old.connection <= candidate.connection && old.boardings <= candidate.boardings)
    {
        return false;
    }
    frontier
        .retain(|old| candidate.connection > old.connection || candidate.boardings > old.boardings);
    frontier.push(candidate);
    true
}
const SCAN_CAN_BOARD: u8 = 1;
const SCAN_CAN_ALIGHT: u8 = 2;
const SCAN_BRIDGE_EXIT: u8 = 4;
const SCAN_RUN_MASK: u32 = (1 << 29) - 1;
const EXIT_TIME_MASK: u32 = (1 << 20) - 1;
const EXIT_RELATIVE_SEGMENT_MASK: u32 = (1 << 15) - 1;
const MAX_PARETO_LABELS: usize = 2_000_000;
// Dominated completions retained for ranked alternatives; they never expand.
const MAX_RANKED_TERMINALS: usize = 65_536;
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
mod types;
pub use types::*;

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
    // Lower bound over this epoch's labels, including labels later replaced.
    // A stale smaller value only prevents pruning; readiness is not required.
    minimum_stop_boardings: Vec<u16>,
    earliest_stop_arrival: Vec<f64>,
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
    reverse_reached_stops: Vec<u32>,
    reverse_reached_runs: Vec<u32>,
    // Compact mirrors of this epoch's reached stops and active runs. The scan
    // tests these cache-resident bits before touching the per-stop and per-run
    // columns; most scanned departures are unreachable.
    reached_stop_bits: Vec<u64>,
    active_run_bits: Vec<u64>,
    /// The departure time of the bucket being scanned. Only a label that
    /// arrives by then can board another departure in the same bucket.
    instant_time: f64,
    instant_labels: u32,
    /// Per stop, the arrivals of its two riding states (alighted, and walked
    /// on after a ride), rounded up. Valid while the stop is active this
    /// epoch. Most alight and transfer candidates are later than the retained
    /// label; this dense copy rejects them without touching the label rows.
    ride_arrival: Vec<[f32; 2]>,
    /// Revisits of a zero-time bucket. Every visit of an event takes a new
    /// tick; a stop records when it last gained a label arriving at the
    /// bucket time, a run when its boarding state last changed. Ticks only
    /// grow, so no array is reset between buckets or queries.
    closure_tick: u64,
    instant_stamp: u64,
    instant_replacements: u32,
    stop_closure_tick: Vec<u64>,
    run_closure_tick: Vec<u64>,
    event_closure_tick: Vec<u64>,
}

#[inline(always)]
fn bit_is_set(bits: &[u64], index: usize) -> bool {
    bits[index >> 6] & (1 << (index & 63)) != 0
}

#[inline(always)]
fn set_bit(bits: &mut [u64], index: usize) {
    bits[index >> 6] |= 1 << (index & 63);
}

impl ScalarWorkspace {
    fn new(stop_count: usize, run_count: usize) -> Self {
        let state_count = stop_count * STATE_STRIDE;
        Self {
            allow_post_ride_transfers: true,
            epoch: 0,
            minimum_stop_boardings: vec![u16::MAX; stop_count],
            earliest_stop_arrival: vec![f64::INFINITY; stop_count],
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
            reverse_reached_stops: vec![0; stop_count],
            reverse_reached_runs: vec![0; run_count],
            reached_stop_bits: vec![0; stop_count.div_ceil(64)],
            active_run_bits: vec![0; run_count.div_ceil(64)],
            instant_time: f64::NEG_INFINITY,
            instant_labels: 0,
            ride_arrival: vec![[f32::INFINITY; 2]; stop_count],
            closure_tick: 0,
            instant_stamp: 0,
            instant_replacements: 0,
            stop_closure_tick: vec![0; stop_count],
            run_closure_tick: vec![0; run_count],
            event_closure_tick: Vec::new(),
        }
    }

    fn ensure_dimensions(&mut self, stops: usize, runs: usize) {
        self.minimum_stop_boardings.resize(stops, u16::MAX);
        self.earliest_stop_arrival.resize(stops, f64::INFINITY);
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
        self.reached_stop_bits.resize(stops.div_ceil(64), 0);
        self.active_run_bits.resize(runs.div_ceil(64), 0);
        self.ride_arrival.resize(stops, [f32::INFINITY; 2]);
        self.stop_closure_tick.resize(stops, 0);
        self.run_closure_tick.resize(runs, 0);
    }

    fn begin_query(&mut self) -> u32 {
        self.touched_runs.clear();
        self.reached_stop_bits.fill(0);
        self.active_run_bits.fill(0);
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            for label in &mut self.labels {
                label.generation = 0;
            }
            self.active_stop_generation.fill(0);
            self.destination_generation.fill(0);
            self.reverse_reached_stops.fill(0);
            self.reverse_reached_runs.fill(0);
            self.run_generation.fill(0);
            self.epoch = 1;
        }
        self.epoch
    }

    fn byte_length(&self) -> usize {
        self.minimum_stop_boardings.len() * std::mem::size_of::<u16>()
            + self.earliest_stop_arrival.len() * std::mem::size_of::<f64>()
            + (self.reached_stop_bits.len() + self.active_run_bits.len())
                * std::mem::size_of::<u64>()
            + self.active_stop_generation.len() * std::mem::size_of::<u32>()
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
            + self.reverse_reached_stops.len() * std::mem::size_of::<u32>()
            + self.reverse_reached_runs.len() * std::mem::size_of::<u32>()
            + self.ride_arrival.len() * std::mem::size_of::<[f32; 2]>()
            + (self.stop_closure_tick.len()
                + self.run_closure_tick.len()
                + self.event_closure_tick.capacity())
                * std::mem::size_of::<u64>()
    }

    /// Whether a riding-state candidate at `stop` is certainly later than the
    /// label it would have to replace. `slot` 0 walks on after a ride; 1 alights.
    #[inline(always)]
    fn ride_candidate_later(&self, epoch: u32, stop: usize, slot: usize, arrival: f64) -> bool {
        self.active_stop_generation[stop] == epoch
            && arrival > f64::from(self.ride_arrival[stop][slot])
    }
}

/// The smallest f32 not below `value`.
#[inline(always)]
fn f32_at_least(value: f64) -> f32 {
    let rounded = value as f32;
    if f64::from(rounded) < value {
        rounded.next_up()
    } else {
        rounded
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
    run_directions: Vec<u32>,
}

impl CompiledTimetableOverlay {
    fn byte_length(&self) -> usize {
        self.events.capacity() * std::mem::size_of::<OverlayScanEvent>()
            + self.run_directions.capacity() * std::mem::size_of::<u32>()
    }
}

fn finite_u32_time(value: f64, label: &str) -> Result<u32> {
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
) -> Result<CompiledTimetableOverlay> {
    let direction_count = input.service_start_seconds.len();
    if input.direction_offsets.len() != direction_count + 1
        || input.direction_offsets.first().copied() != Some(0)
        || input.direction_offsets[direction_count] as usize != input.direction_stops.len()
        || input.direction_stops.len() != input.direction_stop_offsets_seconds.len()
        || input
            .direction_arrival_offsets_seconds
            .as_ref()
            .is_some_and(|times| times.len() != input.direction_stops.len())
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
    let mut run_directions = Vec::new();
    for direction in 0..direction_count {
        let direction_start = input.direction_offsets[direction] as usize;
        let direction_end = input.direction_offsets[direction + 1] as usize;
        if direction_end.saturating_sub(direction_start) < 2 {
            return Err(Error::from_reason(
                "Each Rust timetable overlay direction must contain at least two stops.",
            ));
        }
        let offsets = &input.direction_stop_offsets_seconds[direction_start..direction_end];
        let arrivals = input
            .direction_arrival_offsets_seconds
            .as_ref()
            .map(|times| &times[direction_start..direction_end])
            .unwrap_or(offsets);
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
        if arrivals.iter().enumerate().any(|(index, arrival)| {
            !arrival.is_finite()
                || *arrival < 0.0
                || *arrival > offsets[index]
                || (index > 0 && *arrival < offsets[index - 1])
        }) {
            return Err(Error::from_reason(
                "Rust timetable overlay arrivals must fall between adjacent departures.",
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
                let arrival = trip_start + arrivals[offset_index + 1];
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
                run_directions.push(direction as u32);
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
    Ok(CompiledTimetableOverlay {
        events,
        run_count,
        run_directions,
    })
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
    // Ranked alternatives: every destination completion, in creation order.
    terminals: Vec<u32>,
    overflowed: bool,
    // Query-local overlay identity edges preserve a same-stop interchange
    // minimum. Ordinary explicit walk edges already include their duration.
    identity_transfer_edges: Vec<bool>,
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
            labels: Vec::new(),
            terminals: Vec::new(),
            overflowed: false,
            identity_transfer_edges: Vec::new(),
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
        self.terminals.clear();
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
            + self.terminals.capacity() * std::mem::size_of::<u32>()
            + self.identity_transfer_edges.capacity() * std::mem::size_of::<bool>()
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
    retain_terminals: bool,
    ride_horizon: f64,
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
#[inline(always)]
fn relax_connection_scan<const RETAIN_JOURNEY: bool>(
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
    // Most transfer/alighting candidates are already too late. Reject those
    // before loading their predecessor and computing the secondary objective;
    // equal arrivals still need the complete boarding/walking comparison.
    let retained = workspace.labels[state];
    if arrival > best.arrival || (retained.generation == epoch && arrival > retained.arrival) {
        return NO_STATE;
    }
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
    if workspace.active_stop_generation[stop] != epoch {
        workspace.active_stop_generation[stop] = epoch;
        set_bit(&mut workspace.reached_stop_bits, stop);
        workspace.active_state_mask[stop] = 0;
        workspace.minimum_stop_boardings[stop] = u16::MAX;
        workspace.earliest_stop_arrival[stop] = f64::INFINITY;
        workspace.ride_arrival[stop] = [f32::INFINITY; 2];
    }
    workspace.active_state_mask[stop] |= 1 << (state & (STATE_STRIDE - 1));
    workspace.minimum_stop_boardings[stop] = workspace.minimum_stop_boardings[stop].min(boardings);
    workspace.earliest_stop_arrival[stop] = workspace.earliest_stop_arrival[stop].min(arrival);
    workspace.labels[state] = ScalarLabel {
        arrival,
        generation: epoch,
        boardings,
        walking_seconds,
    };
    if arrival <= workspace.instant_time {
        workspace.instant_labels += 1;
        workspace.stop_closure_tick[stop] = workspace.instant_stamp;
        if retained.generation == epoch {
            workspace.instant_replacements += 1;
        }
    }
    let ride_slot = (state & (STATE_STRIDE - 1)).wrapping_sub(6);
    if ride_slot < 2 {
        workspace.ride_arrival[stop][ride_slot] = f32_at_least(arrival);
    }
    if RETAIN_JOURNEY {
        workspace.predecessors[state] = ScalarPredecessor {
            state: from_state,
            trip,
            duration,
            board_sequence_twice: (board_sequence * 2.0) as u32,
            alight_sequence_twice: (alight_sequence * 2.0) as u32,
            kind,
            _padding: [0; 3],
        };
    }
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
    use super::*;

    #[test]
    fn forward_layers_are_lazy_and_reset_across_depth_and_dimension_changes() {
        let mut workspace = ForwardWorkspace::new(1000, 2000);
        assert!(workspace.run_layers.is_empty());
        assert!(workspace.layer_earliest.is_empty());
        assert!(workspace.layer_ride_earliest.is_empty());
        assert!(workspace.byte_length() < 30_000);
        for (stops, runs, depth) in [
            (1000, 2000, 1),
            (1000, 2000, 32),
            (7, 9, 2),
            (1000, 2000, 4),
        ] {
            workspace.stop_layer_mask.resize(stops, 0);
            workspace.run_layer_mask.resize(runs, 0);
            begin_forward_run_envelope_csa(
                &mut workspace,
                stops,
                runs,
                depth,
                &[0],
                &[0.0],
                10.0,
                100,
                false,
                &vec![0; stops + 1],
                &[],
            );
            assert_eq!(workspace.run_layers.len(), depth);
            assert!(
                workspace
                    .run_layers
                    .iter()
                    .all(|layer| layer.len() == runs && layer.iter().all(|value| *value == 0))
            );
            assert_eq!(workspace.layer_earliest.len(), (depth + 1) * stops);
            assert_eq!(workspace.layer_earliest[0], 10);
            assert!(
                workspace.layer_earliest[1..]
                    .iter()
                    .all(|value| *value == u32::MAX)
            );
            workspace.layer_earliest.fill(0);
            workspace.layer_ride_earliest.fill(0);
            workspace.run_layers[0].fill(1);
        }
    }

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
    let base_stop = stop % workspace.reverse_reached_stops.len();
    workspace.reverse_reached_stops[base_stop] = epoch;
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
fn expand_connection_scan_transfer_edges<const RETAIN_JOURNEY: bool>(
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
        if has_ride
            && workspace.ride_candidate_later(epoch, target, 0, arrival + duration as f64)
        {
            continue;
        }
        relax_connection_scan::<RETAIN_JOURNEY>(
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

// Zero duration does not itself establish identity: a published transfer
// between two different stops may also have a zero minimum. Every overlay
// supplies explicit identities, with -1 for new physical stops.
fn overlay_identity_transfer(
    input: &TimetableOverlayManyQueryInput,
    base_stop_count: usize,
    from: usize,
    edge: usize,
) -> bool {
    if input.supplemental_transfer_duration[edge] != 0 {
        return false;
    }
    let identities = &input.overlay_base_stops;
    let physical_stop = |stop: usize| {
        if stop < base_stop_count {
            Some(stop as i32)
        } else {
            identities
                .get(stop - base_stop_count)
                .copied()
                .filter(|id| *id >= 0)
        }
    };
    let source = physical_stop(from);
    source.is_some() && source == physical_stop(input.supplemental_transfer_to[edge] as usize)
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
    supplemental_identity_edges: &[bool],
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
    for (offset, edge) in supplemental_transfer_edges[start..end].iter().enumerate() {
        let duration = edge.duration();
        // Physical edges carry their interchange duration, even when zero.
        // Only identity bridges retain generic post-ride boarding slack.
        let needs_board_slack = has_ride && supplemental_identity_edges[start + offset];
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
            pareto_alternative(
                arrival,
                boardings,
                walking,
                destination,
                &profile_label_chain(labels, label as i32),
            )
        })
        .collect()
}

fn pareto_alternative(
    arrival: f64,
    boardings: u16,
    walking: f64,
    destination: u32,
    chain: &[JourneyChainStep],
) -> TimetableParetoAlternative {
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
}

/// The earliest distinct completions in (arrival, boardings, walking) order.
/// Completions riding the same sequence of vehicles are one option, whatever
/// stops they use to change or leave; the best-ranked completion represents
/// it. Staying aboard is the same vehicle, so a re-boarding never counts.
fn collect_ranked_alternatives(
    labels: &[ProfileLabel],
    terminals: &[u32],
    destinations: &ScalarWorkspace,
    limit: usize,
) -> Vec<TimetableParetoAlternative> {
    let mut ranked: Vec<(f64, u16, f64, u32, u32)> = terminals
        .iter()
        .map(|&index| {
            let label = &labels[index as usize];
            let stop = label.state as usize / STATE_STRIDE;
            let egress = destinations.destination_egress[stop];
            (
                label.arrival + egress,
                label.boardings,
                label.walking_seconds + egress,
                index,
                destinations.destination_candidate[stop] as u32,
            )
        })
        .collect();
    ranked.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.total_cmp(&right.2))
            .then(left.3.cmp(&right.3))
    });
    let mut rides = std::collections::HashSet::new();
    let mut alternatives = Vec::new();
    for (arrival, boardings, walking, label, destination) in ranked {
        if alternatives.len() >= limit {
            break;
        }
        let chain = profile_label_chain(labels, label as i32);
        let mut vehicles: Vec<i32> = chain
            .iter()
            .filter(|step| step.0 == 2)
            .map(|step| step.3)
            .collect();
        vehicles.dedup();
        if rides.insert(vehicles) {
            alternatives.push(pareto_alternative(
                arrival,
                boardings,
                walking,
                destination,
                &chain,
            ));
        }
    }
    alternatives
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
    let terminal = destination_workspace.destination_generation[stop] == destination_epoch
        && destination_workspace.destination_candidate[stop] >= 0
        && has_ride
        && egress_ready
        && (destination_workspace.allow_post_ride_transfers || kind != 1);
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
            // A ranked search keeps this completion as an inactive witness:
            // it is reported, but never expanded, so the frontier is unchanged.
            if best.retain_terminals
                && terminal
                && arrival + destination_workspace.destination_egress[stop] <= arrival_upper_bound
                && workspace.terminals.len() < MAX_RANKED_TERMINALS
                && workspace.labels.len() < MAX_PARETO_LABELS
            {
                workspace.terminals.push(workspace.labels.len() as u32);
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
                    next: NO_STATE,
                    active: false,
                });
            }
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
    if terminal {
        let destination_arrival = arrival + destination_workspace.destination_egress[stop];
        if destination_arrival <= arrival_upper_bound {
            if best.retain_terminals && workspace.terminals.len() < MAX_RANKED_TERMINALS {
                workspace.terminals.push(label as u32);
            }
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
    for (offset, edge) in transfer_edges[start..end].iter().enumerate() {
        let target = edge.stop();
        let duration = edge.duration();
        let target_arrival = arrival + f64::from(duration);
        if !deadline_allows(stop_deadlines[target], target_arrival) {
            continue;
        }
        let needs_board_slack = !has_ride
            || workspace
                .identity_transfer_edges
                .get(start + offset)
                .copied()
                .unwrap_or(false);
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
            needs_board_slack,
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
    departure_seconds: &columns::View<'_, u32>,
    arrival_seconds: &columns::View<'_, u32>,
    from_stop: &columns::View<'_, u32>,
    to_stop: &columns::View<'_, u32>,
    sequence: &columns::View<'_, u32>,
    segment_trip: &columns::View<'_, u32>,
    segment_run: &columns::View<'_, u32>,
    continuity_break: &columns::View<'_, u8>,
    can_board: &columns::View<'_, u8>,
    can_alight: &columns::View<'_, u8>,
    departure_offset: &[u32],
    departure_events: &[DepartureEvent],
    transfer_offset: &[u32],
    transfer_edges: &[TransferEdge],
    forbidden_same_stop: &[u8],
    same_stop_transfer_minimum: &[u32],
    transfer_buffer_seconds: u32,
    run_start: &[u32],
    run_end: &[u32],
    stop_deadlines: &[u32],
    feasible_runs: &[u8],
    arrival_upper_bound: f64,
    boarding_upper_bound: u16,
    transfer_penalty_seconds: f64,
    walk_reluctance: f64,
) -> Vec<i32> {
    // The final arrival bound can include terminal walking beyond the ride
    // horizon. Boarding, bridge exits and ride alighting retain the scalar
    // scan's horizon; transfers and final egress keep the arrival bound.
    let ride_upper_bound = arrival_upper_bound.min(best.ride_horizon);
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
            if flags & 4 != 0 && flags & 1 != 0 && forbidden_same_stop[stop] == 1 {
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
                    transfer_buffer_seconds,
                ));
                minimum_walking = minimum_walking.min(current.walking_seconds);
                label = current.next;
            }
        }
        if !earliest_ready.is_finite() || earliest_ready > ride_upper_bound {
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
            if event.departure as f64 > ride_upper_bound.min(latest_objective_departure) {
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
            if connection_departure > ride_upper_bound.min(latest_objective_departure) {
                break;
            }
            stats.scanned_departures += 1;
            let stop = from_stop[connection] as usize;
            if can_board[connection] == 1 {
                let mut candidate = NO_STATE;
                let mut candidate_walking = predecessor_walking;
                for flags in 0..STATE_STRIDE {
                    if flags & 4 != 0 && flags & 1 != 0 && forbidden_same_stop[stop] == 1 {
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
                            transfer_buffer_seconds,
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
            if can_alight[connection] == 1 && arrival_seconds[connection] as f64 <= ride_upper_bound
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
    /// Counted while the corridor is built, from the runs and stops it admits.
    structure: CorridorStructureStats,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ParetoRestrictionMode {
    Only,
    Forward,
    Reverse,
    Both,
}

impl ParetoRestrictionMode {
    fn parse(value: Option<&str>) -> Result<Self> {
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
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

impl CorridorStructureStats {
    fn new(stop_count: usize, run_count: usize, segment_count: usize, layers: usize) -> Self {
        Self {
            total_run_layer_memberships: (run_count * layers) as u64,
            total_segment_layer_memberships: (segment_count * layers) as u64,
            total_stop_deadline_memberships: (stop_count * (layers + 1)) as u64,
            restriction_bytes: (layers + 1) * stop_count * std::mem::size_of::<u32>()
                + layers * run_count * std::mem::size_of::<u8>(),
            ..Self::default()
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_open_deadline_corridor(
    stop_count: usize,
    run_count: usize,
    segment_count: usize,
    boarding_upper_bound: usize,
    apply_forward_filter: bool,
    forward_run_layers: Option<&[Vec<u8>]>,
    forward_universal_runs: &[u64],
    run_start: &[u32],
    run_end: &[u32],
) -> ExactDeadlineCorridor {
    let stop_deadlines = (0..=boarding_upper_bound)
        .map(|_| vec![u32::MAX; stop_count])
        .collect();
    let mut structure =
        CorridorStructureStats::new(stop_count, run_count, segment_count, boarding_upper_bound);
    structure.retained_stop_deadline_memberships = structure.total_stop_deadline_memberships;
    let mut retained_runs = vec![false; if apply_forward_filter { run_count } else { 0 }];
    let mut run_layers = Vec::with_capacity(boarding_upper_bound);
    for remaining in 0..boarding_upper_bound {
        if !apply_forward_filter {
            run_layers.push(vec![1; run_count]);
            structure.retained_run_layer_memberships += run_count as u64;
            structure.retained_segment_layer_memberships += segment_count as u64;
            structure.retained_unique_runs = run_count as u32;
            continue;
        }
        let forward_round = boarding_upper_bound - remaining - 1;
        let forward_runs = forward_run_layers.map(|layers| &layers[forward_round]);
        run_layers.push(
            (0..run_count)
                .map(|run| {
                    let retained = has_run_bit(forward_universal_runs, run)
                        || forward_runs.is_some_and(|runs| runs[run] != 0);
                    if retained {
                        structure.retained_run_layer_memberships += 1;
                        structure.retained_segment_layer_memberships +=
                            u64::from(run_end[run].saturating_sub(run_start[run]));
                        if !retained_runs[run] {
                            retained_runs[run] = true;
                            structure.retained_unique_runs += 1;
                        }
                    }
                    u8::from(retained)
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
        structure,
    }
}

/// Reference count over the complete corridor; debug builds check the
/// incremental counts against it.
#[cfg(debug_assertions)]
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
    scalar_first_boarding: Vec<u32>,
    scalar_identity: Option<ScalarEnvelopeIdentity>,
    envelope_revision: u64,
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
            // This is an unrestricted reachability envelope, independent of
            // the certifier's boarding bound. A later capped arrival can reuse
            // its scanned prefix too: the certifier admits every run in the
            // unscanned suffix up to its new deadline below.
            && f64::from_bits(self.best_arrival) <= input.earliest_arrival
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
            run_layers: Vec::new(),
            changed_stops: Vec::new(),
            layer_earliest: Vec::new(),
            layer_ride_earliest: Vec::new(),
            stop_layer_mask: vec![0; stop_count],
            run_layer_mask: vec![0; run_count],
            scalar_runs: vec![0; run_count.div_ceil(u64::BITS as usize)],
            scalar_first_boarding: vec![u32::MAX; run_count],
            scalar_identity: None,
            envelope_revision: 0,
        }
    }

    fn byte_length(&self) -> usize {
        self.run_layers
            .iter()
            .map(|layer| layer.capacity() * std::mem::size_of::<u8>())
            .sum::<usize>()
            + self.changed_stops.capacity() * std::mem::size_of::<usize>()
            + self.layer_earliest.capacity() * std::mem::size_of::<u32>()
            + self.layer_ride_earliest.capacity() * std::mem::size_of::<u32>()
            + self.stop_layer_mask.capacity() * std::mem::size_of::<u32>()
            + self.run_layer_mask.capacity() * std::mem::size_of::<u32>()
            + self.scalar_runs.capacity() * std::mem::size_of::<u64>()
            + self.scalar_first_boarding.capacity() * std::mem::size_of::<u32>()
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
    if offer_forward_layer(
        &mut workspace.layer_earliest,
        &mut workspace.stop_layer_mask,
        stop_count,
        layer,
        stop,
        arrival,
        maximum_time,
    ) {
        workspace.envelope_revision += 1;
    }
    let index = layer * stop_count + stop;
    // An earlier walking arrival has already consumed its transfer edge. It
    // cannot suppress a later ride exit that can still take an ingress edge.
    if arrival > maximum_time || arrival >= workspace.layer_ride_earliest[index] {
        return 0;
    }
    workspace.layer_ride_earliest[index] = arrival;
    workspace.envelope_revision += 1;
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
    // Most scalar queries reuse their universal envelope and never need
    // layered forward storage. Allocate only the requested boarding depth.
    workspace
        .run_layers
        .resize_with(boarding_upper_bound, Vec::new);
    for layer in &mut workspace.run_layers {
        layer.resize(run_count, 0);
    }
    workspace
        .layer_earliest
        .resize((boarding_upper_bound + 1) * stop_count, u32::MAX);
    workspace
        .layer_ride_earliest
        .resize((boarding_upper_bound + 1) * stop_count, u32::MAX);
    debug_assert_eq!(workspace.run_layer_mask.len(), run_count);
    workspace.layer_earliest.fill(u32::MAX);
    workspace.layer_ride_earliest.fill(u32::MAX);
    workspace.stop_layer_mask.fill(0);
    workspace.run_layer_mask.fill(0);
    workspace.envelope_revision = 0;
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
                workspace.envelope_revision += 1;
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
    scan_time_needs_closure: &[bool],
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
        // Zero-time arrivals and bridge exits may make an earlier event in
        // this bucket boardable. Close the monotone reachability state before
        // using its run layers as a pruning envelope. Counters record actual
        // work, while the revision changes only on a new run/layer or an
        // improved ride exit; repeated scans therefore reach a fixed point.
        loop {
            let previous_revision = workspace.envelope_revision;
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
            if !scan_time_needs_closure[time_index]
                || previous_revision == workspace.envelope_revision
            {
                break;
            }
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
    forward_first_boarding: Option<&[u32]>,
    destination_stops: &[u32],
    destination_walk_seconds: &[f64],
    departure_seconds: &columns::View<'_, u32>,
    sequence: &columns::View<'_, u32>,
    from_stop: &columns::View<'_, u32>,
    can_board: &columns::View<'_, u8>,
    run_start: &[u32],
    run_end: &[u32],
    segment_count: usize,
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
    let mut structure =
        CorridorStructureStats::new(stop_count, run_count, segment_count, boarding_upper_bound);
    // Layer masks only grow in the incremental case; otherwise retain a union.
    let mut ever_retained = Vec::new();
    let (mut layer_runs, mut layer_segments) = (0_u64, 0_u64);
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
            (layer_runs, layer_segments) = (0, 0);
            if ever_retained.is_empty() {
                ever_retained = vec![false; run_count];
            }
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
            let mut start = run_start[run].max(processed_through[run]) as usize;
            let end = run_through[run] as usize;
            if let Some(first_boarding) = forward_first_boarding {
                // The scalar scan proved that no earlier position on this run
                // is boardable from these origins. A later alighting event
                // cannot make that unreachable prefix useful in reverse.
                if first_boarding[run] != u32::MAX {
                    let mut hi = end;
                    while start < hi {
                        let mid = start + (hi - start) / 2;
                        if sequence[mid] < first_boarding[run] {
                            start = mid + 1;
                        } else {
                            hi = mid;
                        }
                    }
                }
            }
            run_segments_scanned = run_segments_scanned.saturating_add((end - start) as u64);
            let carried = run_mask[run] != 0;
            let mut boardable = carried;
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
            if boardable && !carried {
                layer_runs += 1;
                layer_segments += u64::from(run_end[run].saturating_sub(run_start[run]));
                if !incremental && !ever_retained[run] {
                    ever_retained[run] = true;
                    structure.retained_unique_runs += 1;
                }
            }
        }
        structure.retained_run_layer_memberships += layer_runs;
        structure.retained_segment_layer_memberships += layer_segments;
        if incremental {
            structure.retained_unique_runs = layer_runs as u32;
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
    structure.retained_stop_deadline_memberships =
        stop_lists.iter().map(|stops| stops.len() as u64).sum();
    ExactDeadlineCorridor {
        stop_deadlines,
        run_layers,
        exit_events_scanned,
        run_segments_scanned,
        transfer_edges_scanned,
        structure,
    }
}

fn boarding_ready_time(
    arrival: f64,
    has_ride: bool,
    transfer_episode_state: bool,
    minimum: u32,
    transfer_buffer_seconds: u32,
) -> f64 {
    arrival
        + if has_ride && transfer_episode_state {
            f64::from(minimum)
        } else {
            0.0
        }
        + if has_ride {
            f64::from(transfer_buffer_seconds)
        } else {
            0.0
        }
}
pub struct TimetableKernel {
    stop_count: usize,
    run_count: usize,
    departure_seconds: SourceU32,
    arrival_seconds: SourceU32,
    from_stop: SourceU32,
    to_stop: SourceU32,
    sequence: SourceU32,
    segment_trip: SourceU32,
    segment_run: SourceU32,
    continuity_break: SourceU8,
    can_board: SourceU8,
    can_alight: SourceU8,
    trip_start: SourceU32,
    // These offsets index native-owned compact event arrays, so keep them in
    // the same immutable ownership domain instead of retaining JS views.
    departure_offset: Vec<u32>,
    departure_events: Vec<DepartureEvent>,
    transfer_offset: Vec<u32>,
    transfer_edges: Vec<TransferEdge>,
    forbidden_same_stop: U8Buffer,
    same_stop_transfer_minimum: Vec<u32>,
    minimum_transfer_buffer_seconds: u32,
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
    query: TimetableQueryWorkspace,
}

// Query scratch is independent of the immutable schedule. A sequential worker
// lends one workspace to each scenario for the duration of its request.
pub struct TimetableQueryWorkspace {
    workspace: ScalarWorkspace,
    many_workspace: ManyWorkspace,
    forward_workspace: ForwardWorkspace,
    profile_workspace: ProfileWorkspace,
    journey_workspace: Option<journeys::JourneyWorkspace>,
}
impl TimetableQueryWorkspace {
    fn new(stops: usize, runs: usize, trips: usize) -> Self {
        Self {
            workspace: ScalarWorkspace::new(stops, runs),
            many_workspace: ManyWorkspace::new(stops, runs, trips),
            forward_workspace: ForwardWorkspace::new(stops, runs),
            profile_workspace: ProfileWorkspace::new(stops * STATE_STRIDE, runs),
            journey_workspace: None,
        }
    }
    pub fn byte_length(&self) -> usize {
        self.workspace.byte_length()
            + self.many_workspace.byte_length()
            + self.forward_workspace.byte_length()
            + self.profile_workspace.byte_length()
            + self
                .journey_workspace
                .as_ref()
                .map_or(0, journeys::JourneyWorkspace::byte_length)
    }
    fn rebind(&mut self, stops: usize, runs: usize, trips: usize) {
        // Epochs must invalidate all labels, even when two schedules have the
        // same dimensions. Scalar continuation belongs to one request only.
        let w = &mut self.workspace;
        w.ensure_dimensions(
            stops.max(w.active_stop_generation.len()),
            runs.max(w.run_generation.len()),
        );
        // These tags index physical stops/runs, not the expanded boarding
        // layers retained in the other arrays. Reverse pruning uses their
        // exact dimensions to map a layered state back to its base stop.
        w.reverse_reached_stops.resize(stops, 0);
        w.reverse_reached_runs.resize(runs, 0);
        w.epoch = u32::MAX;
        let w = &mut self.many_workspace;
        w.ensure_dimensions(stops, runs);
        w.excluded_trip_generation
            .resize(trips.max(w.excluded_trip_generation.len()), 0);
        w.epoch = u32::MAX;
        let w = &mut self.profile_workspace;
        let states = (stops * STATE_STRIDE).max(w.transfer_generation.len());
        w.transfer_generation.resize(states, 0);
        w.transfer_label.resize(states, NO_STATE);
        w.frontier_generation.resize(states, 0);
        w.frontier_head.resize(states, NO_STATE);
        w.run_generation.resize(runs.max(w.run_generation.len()), 0);
        w.epoch = u32::MAX;
        let w = &mut self.forward_workspace;
        for layer in &mut w.run_layers {
            layer.resize(runs, 0);
        }
        // Layered arrays are resized and reset by the next forward search.
        // A scalar-only scenario must not allocate all possible layers.
        w.layer_earliest.clear();
        w.layer_ride_earliest.clear();
        w.stop_layer_mask.resize(stops, 0);
        w.run_layer_mask.resize(runs, 0);
        w.scalar_runs.resize(runs.div_ceil(u64::BITS as usize), 0);
        w.scalar_first_boarding.resize(runs, u32::MAX);
        w.scalar_identity = None;
        if let Some(w) = &mut self.journey_workspace {
            w.rebind(stops, runs);
        }
    }
}
impl Default for TimetableQueryWorkspace {
    fn default() -> Self {
        Self::new(0, 0, 0)
    }
}
impl TimetableKernel {
    pub fn share_source_columns(&mut self, pool: &mut TimetableBlockPool) -> bool {
        let mut changed = false;
        changed |= pool.share_u32(&mut self.departure_seconds);
        changed |= pool.share_u32(&mut self.arrival_seconds);
        changed |= pool.share_u32(&mut self.from_stop);
        changed |= pool.share_u32(&mut self.to_stop);
        changed |= pool.share_u32(&mut self.sequence);
        changed |= pool.share_u32(&mut self.segment_trip);
        changed |= pool.share_u32(&mut self.segment_run);
        changed |= pool.share_u32(&mut self.trip_start);
        changed |= pool.share_u8(&mut self.continuity_break);
        changed |= pool.share_u8(&mut self.can_board);
        changed |= pool.share_u8(&mut self.can_alight);
        changed
    }
    pub fn source_block_references(&self) -> usize {
        self.departure_seconds.block_references()
            + self.arrival_seconds.block_references()
            + self.from_stop.block_references()
            + self.to_stop.block_references()
            + self.sequence.block_references()
            + self.segment_trip.block_references()
            + self.segment_run.block_references()
            + self.trip_start.block_references()
            + self.continuity_break.block_references()
            + self.can_board.block_references()
            + self.can_alight.block_references()
    }
    pub fn owned_source_bytes(&self) -> usize {
        self.departure_seconds.allocated_bytes()
            + self.arrival_seconds.allocated_bytes()
            + self.from_stop.allocated_bytes()
            + self.to_stop.allocated_bytes()
            + self.sequence.allocated_bytes()
            + self.segment_trip.allocated_bytes()
            + self.segment_run.allocated_bytes()
            + self.trip_start.allocated_bytes()
            + self.continuity_break.allocated_bytes()
            + self.can_board.allocated_bytes()
            + self.can_alight.allocated_bytes()
            + self.forbidden_same_stop.capacity()
            + self.same_stop_transfer_minimum.capacity() * 4
    }
    pub fn take_query_workspace(&mut self) -> TimetableQueryWorkspace {
        std::mem::take(&mut self.query)
    }
    /// The transfer buffer is read only while searching, so one prepared
    /// timetable serves every buffer a request selects.
    pub fn set_minimum_transfer_buffer_seconds(&mut self, seconds: u32) {
        self.minimum_transfer_buffer_seconds = seconds;
    }
    pub fn retained_schedule_bytes(&self) -> usize {
        self.owned_source_bytes()
            + self.diagnostics().native_index_bytes as usize
            + self.departure_seconds.shared_retained_bytes()
            + self.arrival_seconds.shared_retained_bytes()
            + self.from_stop.shared_retained_bytes()
            + self.to_stop.shared_retained_bytes()
            + self.sequence.shared_retained_bytes()
            + self.segment_trip.shared_retained_bytes()
            + self.segment_run.shared_retained_bytes()
            + self.trip_start.shared_retained_bytes()
            + self.continuity_break.shared_retained_bytes()
            + self.can_board.shared_retained_bytes()
            + self.can_alight.shared_retained_bytes()
    }
    pub fn install_query_workspace(&mut self, mut query: TimetableQueryWorkspace) {
        query.rebind(
            self.stop_count,
            self.run_count,
            self.trip_start.len().saturating_sub(1),
        );
        self.query = query;
    }
}
mod alternatives;
mod arrive;
mod construction;
mod depart;
mod diagnostics;
mod many;
mod matrix;
mod overlay;

pub fn boarding_layers(maximum: Option<u32>) -> Result<usize> {
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
