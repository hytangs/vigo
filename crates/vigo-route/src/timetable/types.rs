//! Canonical timetable operator inputs and results.
use super::*;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimetableKernelInput {
    pub stop_count: u32,
    pub run_count: u32,
    pub departure_seconds: U32Buffer,
    pub arrival_seconds: U32Buffer,
    pub from_stop: U32Buffer,
    pub to_stop: U32Buffer,
    pub sequence: U32Buffer,
    pub segment_trip: U32Buffer,
    pub segment_run: U32Buffer,
    pub continuity_break: U8Buffer,
    pub can_board: U8Buffer,
    pub can_alight: U8Buffer,
    pub trip_start: U32Buffer,
    pub departure_offset: U32Buffer,
    pub departure_order: U32Buffer,
    pub transfer_offset: U32Buffer,
    pub transfer_to: U32Buffer,
    pub transfer_duration: U32Buffer,
    pub forbidden_same_stop: U8Buffer,
    pub same_stop_transfer_minimum: Option<U32Buffer>,
    pub minimum_transfer_buffer_seconds: Option<u32>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone)]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// Resident identity for each overlay stop, or -1 for a new scenario stop.
    /// Realtime replacements inherit the original station's transfer rules.
    pub overlay_base_stops: Vec<i32>,
    pub direction_offsets: Vec<u32>,
    pub direction_stops: Vec<u32>,
    pub direction_stop_offsets_seconds: Vec<f64>,
    /// Optional arrival offsets preserve dwell time in realtime replacements.
    /// Frequency scenarios without this field retain their existing offsets.
    pub direction_arrival_offsets_seconds: Option<Vec<f64>>,
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
    /// Certify secondary objectives for a single journey, without charging
    /// matrix/scenario callers for itinerary ranking.
    pub certify_journey: Option<bool>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimetableOverlayManyQueryResult {
    pub timetable: TimetableManyQueryResult,
    pub overlay_connections: u32,
    pub overlay_runs: u32,
    /// Input direction for each query-local run. Expired directions may emit
    /// no runs and frequency directions may emit several.
    pub overlay_run_directions: Vec<u32>,
    pub supplemental_transfer_edges: u32,
    pub compile_ns: f64,
    pub scan_ns: f64,
    pub transient_bytes: f64,
    pub workspace_bytes: f64,
    pub lexicographic_certified: bool,
    pub quality_query_ns: f64,
    pub quality_bytes: f64,
    pub quality_reason: Option<String>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone)]
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
    /// `pareto` (default) returns nondominated completions; `ranked` returns
    /// the earliest distinct completions, including dominated ones.
    pub alternative_ranking: Option<String>,
    /// Maximum ranked completions returned; Pareto frontiers are complete.
    pub alternative_limit: Option<u32>,
    /// Optional exact corridor restriction mode used by the production Pareto certifier.
    pub restriction_mode: Option<String>,
    pub allow_post_ride_transfers: Option<bool>,
    /// At a fixed latest departure, minimize boardings, then walking, then
    /// arrival, subject to the supplied hard arrival bound.
    pub deadline_objective: Option<bool>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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

/// Alternatives around a known primary journey. Both runtimes send this one
/// request so their candidate sets cannot drift.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimetableAlternativeQueryInput {
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
    /// The primary arrival for depart-at searches; the deadline for arrive-by.
    pub earliest_arrival: f64,
    pub arrival_slack_seconds: f64,
    pub best_boardings: u32,
    pub maximum_boardings: Option<u32>,
    pub ranking: Option<String>,
    pub limit: Option<u32>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
