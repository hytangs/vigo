//! Results: what the engine returns for each query, one schema per family.
//!
//! Read `status` first. `ok` carries the answer; `not_found` is a valid answer
//! that no journey satisfies the request; errors use `vigo.error.v1`.

use crate::{
    Bounds, Coordinate, DataMode, Identifier, Journey, Maybe, Mode, Number, TimePreference,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Any document the engine writes for a query, keyed by its `schema`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "schema")]
pub enum Response {
    #[serde(rename = "vigo.route.v1")]
    Route(Box<RouteResult>),
    #[serde(rename = "vigo.matrix.v1")]
    Matrix(Box<MatrixResult>),
    #[serde(rename = "vigo.reach.v1")]
    Reach(Box<ReachResult>),
    #[serde(rename = "vigo.compare.v1")]
    Compare(Box<CompareResult>),
    #[serde(rename = "vigo.info.v1")]
    Info(Box<InfoResult>),
    #[serde(rename = "vigo.scenarios.info.v1")]
    CollectionInfo(Box<CollectionInfoResult>),
    #[serde(rename = "vigo.stream.detail.v1")]
    StreamDetail(Box<StreamDetail>),
    #[serde(rename = "vigo.error.v1")]
    Error(Box<ErrorResult>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryStatus {
    Ok,
    /// A valid outcome: nothing satisfies the request.
    NotFound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OkStatus {
    Ok,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorStatus {
    Error,
}

/// How this Result was computed and how to reproduce it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub engine_version: String,
    pub city_revision: Option<String>,
    /// The caller's `id` when given; otherwise generated.
    pub request_id: Value,
    /// Hash of the request (stop references canonicalized, output switches
    /// excluded) and the City revision.
    pub query_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assumptions_fingerprint: Option<String>,
    /// Service-date activation, search and materialization, in microseconds.
    pub compute_us: Option<u64>,
    /// `query_dispatch_including_materialization`.
    pub compute_scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realtime_snapshot_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realtime: Option<RealtimeReport>,
    /// Admission and road matching evidence for supplied traffic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traffic: Option<serde_json::Value>,
}

/// How a supplied realtime snapshot was admitted and applied.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeReport {
    /// Such as `applied` or `stale_fallback`.
    pub status: String,
    pub mode: String,
    pub coverage: RealtimeCoverage,
    pub feed_trip_updates: u64,
    pub applied_trips: u64,
    pub canceled_trips: u64,
    pub stale_trips: u64,
    pub unmatched_trips: u64,
    pub invalid_trips: u64,
    pub duplicate_trips: u64,
    pub date_mismatches: u64,
    pub past_prefix_trips: u64,
    pub omitted_past_prefix_stops: u64,
    /// Present when the server's live snapshot was used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<LiveSnapshotReport>,
    /// Present when the snapshot carries Service Alerts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alerts: Option<AlertReport>,
}

/// The live publication a query used: `vigo serve --realtime-poll`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshotReport {
    /// `server`.
    pub source: String,
    /// Content identifier; equal snapshots have equal identifiers.
    pub id: String,
    pub generation: u64,
    /// Each configured source's kind, scope, feed timestamp and failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feeds: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlertReport {
    pub received: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<u64>,
    /// Fresh `NO_SERVICE` alerts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_service: Option<u64>,
    /// Entities that select nothing VIGO can resolve, such as an agency alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported_entities: Option<u64>,
    /// Ride segments that lost boarding or alighting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_boardings: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_alightings: Option<u64>,
    /// `timezone_required` when the City clock is ambiguous.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeCoverage {
    pub applied_updates: u64,
    pub rejected_updates: u64,
    pub complete: bool,
}

/// The request as the engine understood it. Endpoints echo the caller's places.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RouteQuery {
    pub service_date: Option<String>,
    pub time_preference: TimePreference,
    pub requested_time: Option<String>,
    pub data_mode: DataMode,
    pub origin: QueryPlace,
    pub destination: QueryPlace,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrival_reserve_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_arrival_time: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MatrixQuery {
    pub service_date: Option<String>,
    pub time_preference: TimePreference,
    pub requested_time: Option<String>,
    pub data_mode: DataMode,
    pub origins: Vec<QueryPlace>,
    pub destinations: Vec<QueryPlace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrival_reserve_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_arrival_time: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReachQuery {
    pub service_date: Option<String>,
    pub time_preference: TimePreference,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub requested_time: Maybe<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all_day: Option<AllDayQuery>,
    pub data_mode: DataMode,
    /// Depart-at Reach.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<QueryPlace>,
    /// Arrive-by Reach.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<QueryPlace>,
}

/// A requested place, in public form.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct QueryPlace {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Identifier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate: Option<Coordinate>,
    /// The caller's Matrix endpoint `id`.
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
}

/// A code for programs and a message for people.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Notice {
    pub code: String,
    pub message: String,
}

/// The wheelchair profile a Result was computed under.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Accessibility {
    /// `wheelchair-strict-v1`.
    pub profile: String,
    /// `exclude`: unknown accessibility counts as inaccessible.
    pub unknown_data: String,
    pub station_paths: String,
    pub maximum_slope: Number,
    pub minimum_width_meters: Number,
    pub limitations: Vec<String>,
}

/// Search counters, with `diagnostics: "summary"` or more. Counters without
/// instrumentation are omitted.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scanned_departures: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expanded_trip_runs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relaxed_stops: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dominated_trip_boardings: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explicit_transfer_checks: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forward_searches: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverse_searches: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_candidates: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_candidates: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cch_accelerated: Option<bool>,
}

/// Measured timings, with `diagnostics: "profile"` or `"trace"`. Scopes can
/// overlap; do not add them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Dotted scope names to integer microseconds.
    pub timings_us: BTreeMap<String, i64>,
    pub note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_dispatch: Option<RoutingDispatch>,
}

/// Result-search dispatch for the resident timetable, excluding certificate scans.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "semantics", rename_all = "snake_case")]
pub enum RoutingDispatch {
    Ordinary,
    Scoped {
        #[serde(rename = "ordinarySearches")]
        ordinary_searches: u64,
        #[serde(rename = "statefulSearches")]
        stateful_searches: u64,
        /// `resident_timetable_cumulative`; resets when the timetable is replaced.
        counts: String,
    },
}

/// How a place attached to the street network, reported when access fails.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessReport {
    /// `origin` or `destination`.
    pub role: String,
    /// Such as `available` or `no_access`.
    pub code: String,
    pub candidate_count: u64,
    pub coordinate: Coordinate,
    pub maximum_walk_meters: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_walk_meters: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_walk_meters: Option<Number>,
    /// With `street_access_unverified`: the nearest stop serving the role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearest_stop: Option<NearestStop>,
}

/// A stop near an endpoint whose street access was not verified.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NearestStop {
    pub id: String,
    pub name: String,
    pub distance_km: Number,
    /// `straight_line`: proximity, not walking distance.
    pub distance_kind: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RouteAccess {
    pub origin: AccessReport,
    pub destination: AccessReport,
}

/// Matrix access reports, keyed by endpoint index.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MatrixAccess {
    pub origins: BTreeMap<String, AccessReport>,
    pub destinations: BTreeMap<String, AccessReport>,
}

/// How alternatives were found: requested alternatives, or a journey window.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlternativeSearch {
    /// `requested_time` for requested alternatives, `sampled` for a window.
    pub coverage: String,
    /// Includes the primary journey.
    pub maximum_journeys: u32,
    pub arrival_slack_minutes: Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ranking: Option<String>,
    /// `complete` or `unavailable`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Window sampling direction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_minutes: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub searches: Option<u32>,
}

/// A dataset or model limitation of the City.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DatasetLimitation {
    pub code: String,
    /// Affected source records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// Such as `unsupported` or `unknown`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exactness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RouteResult {
    pub status: QueryStatus,
    pub mode: Mode,
    pub query: RouteQuery,
    pub meta: Meta,
    /// `null` when `status` is `not_found`.
    pub journey: Option<Journey>,
    /// Further distinct journeys; omitted when there are none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<Journey>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternative_search: Option<AlternativeSearch>,
    /// Why no journey was found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<Notice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<RouteAccess>,
    /// Qualifications of the returned journey.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<Notice>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessibility: Option<Accessibility>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_limitations: Option<Vec<DatasetLimitation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<SearchSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<Profile>,
    /// The unstable internal result, with `diagnostics: "trace"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<Value>,
    /// The caller's `id`.
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
    /// Line number on a resident stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MatrixResult {
    pub status: QueryStatus,
    pub mode: Mode,
    pub query: MatrixQuery,
    pub meta: Meta,
    /// `[origin][destination]` seconds; `null` when unreachable, never zero.
    pub durations_seconds: Vec<Vec<Option<u64>>>,
    /// Same order as `durationsSeconds`, with `includeJourneys`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journeys: Option<Vec<Vec<Option<Journey>>>>,
    /// Driving distances, `[origin][destination]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distances_meters: Option<Vec<Vec<Option<Number>>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<MatrixAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessibility: Option<Accessibility>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_limitations: Option<Vec<DatasetLimitation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<SearchSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<Profile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<Value>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

/// Reached time on a regular grid, row-major from the northwest corner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReachSurface {
    pub width: u32,
    pub height: u32,
    pub bounds: Bounds,
    /// Seconds per cell; `null` when unreachable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values_seconds: Option<Vec<Option<u64>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable_samples: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mean_reachable_duration_seconds: Option<Vec<Option<Number>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable_samples_by_cutoff: Option<Vec<Vec<u32>>>,
    /// Reached street intervals, with `includeStreetEdges`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edges: Option<StreetEdges>,
    /// Reached street nodes, with `includeNodes`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nodes: Option<Vec<SurfaceNode>>,
}

/// Reached street intervals in indexed form. Every per-interval array has
/// `count` entries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StreetEdges {
    /// `vigo.standalone.street-edges.v2`.
    pub schema_version: String,
    /// `indexed-json`.
    pub encoding: String,
    pub count: u64,
    pub node_count: u64,
    /// Flat longitude/latitude pairs, `2 * nodeCount` long.
    pub nodes: Vec<Number>,
    /// From/to local node indices, `2 * count` long.
    pub endpoints: Vec<u32>,
    pub edge_ids: Vec<u64>,
    /// Elapsed minutes at each interval end.
    pub duration_minutes: Vec<Number>,
    /// Elapsed minutes at each interval start.
    pub from_duration_minutes: Vec<Number>,
    pub start_fractions: Vec<Number>,
    pub end_fractions: Vec<Number>,
    pub walk_distance_m: Vec<Number>,
    /// Elapsed minutes at the transit seed; −1 for the direct-origin seed.
    pub transit_arrival_minutes: Vec<Number>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceNode {
    pub longitude: Option<Number>,
    pub latitude: Option<Number>,
    pub duration_minutes: Option<Number>,
    pub walk_distance_m: Option<Number>,
}

/// A stop reached by Reach, and when.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReachStop {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Identifier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate: Option<Coordinate>,
    pub duration_seconds: Option<u64>,
}

/// A GeoJSON `FeatureCollection` of cutoff areas or contours.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename = "FeatureCollection")]
#[schemars(rename = "CutoffFeatures", transform = crate::schema::type_tag("FeatureCollection"))]
pub struct CutoffFeatures {
    pub features: Vec<CutoffFeature>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename = "Feature")]
#[schemars(rename = "CutoffFeature", transform = crate::schema::type_tag("Feature"))]
pub struct CutoffFeature {
    pub properties: CutoffProperties,
    pub geometry: CutoffGeometry,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CutoffProperties {
    pub cutoff_minutes: Number,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", content = "coordinates")]
pub enum CutoffGeometry {
    MultiPolygon(Vec<Vec<Vec<Coordinate>>>),
    MultiLineString(Vec<Vec<Coordinate>>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReachResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all_day: Option<AllDaySummary>,
    pub status: QueryStatus,
    pub mode: Mode,
    pub query: ReachQuery,
    pub meta: Meta,
    pub cutoffs_seconds: Vec<u64>,
    /// Areas within each cutoff. With `reachFormat: "map"`, these cover the
    /// full reached extent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub areas: Option<CutoffFeatures>,
    /// Full reached extent, with `reachFormat: "map"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<ReachSurface>,
    /// The same grid over the complete reached extent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_surface: Option<ReachSurface>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contours: Option<CutoffFeatures>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_areas: Option<CutoffFeatures>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_contours: Option<CutoffFeatures>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stops: Option<Vec<ReachStop>>,
    /// Stops added by a scenario.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_stops: Option<Vec<ReachStop>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessibility: Option<Accessibility>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_limitations: Option<Vec<DatasetLimitation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<SearchSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<Profile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<Value>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

/// Changes between two saved Results, after minus before, in seconds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub status: OkStatus,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub before_status: Maybe<QueryStatus>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub after_status: Maybe<QueryStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city_revisions: Option<CityRevisions>,
    /// Route: change in journey duration.
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub duration_change_seconds: Maybe<i64>,
    /// Route: change in transfers.
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub transfer_change: Maybe<i64>,
    /// Matrix and Reach: cell and pair counts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts: Option<CompareCounts>,
    /// Matrix and Reach: mean over mutually reachable entries; `null` when none.
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub mean_change_seconds: Maybe<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<Value>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CityRevisions {
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompareCounts {
    pub comparable: u64,
    pub newly_reachable: u64,
    pub no_longer_reachable: u64,
    /// Omitted when comparing internal trace results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub faster: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slower: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unchanged: Option<u64>,
}

/// A loaded City: identity, sources, size and limits.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InfoResult {
    pub status: OkStatus,
    pub name: Option<String>,
    pub revision: Option<String>,
    pub engine_version: String,
    pub counts: CityCounts,
    pub sources: CitySources,
    pub dataset_limitations: Vec<DatasetLimitation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_policy: Option<ResourcePolicy>,
    /// Process memory accounting. Diagnostic; its fields may change.
    pub memory: Value,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CityCounts {
    pub routes: Option<u64>,
    pub stops: Option<u64>,
    pub trips: Option<u64>,
    pub connections: Option<u64>,
    pub street_nodes: Option<u64>,
    pub street_edges: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CitySources {
    pub gtfs: Vec<GtfsSource>,
    pub osm: Option<OsmSource>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GtfsSource {
    pub name: Option<String>,
    /// The feed's scope.
    pub feed: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct OsmSource {
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePolicy {
    /// Detected memory capacity; `null` when unknown.
    pub memory_capacity_bytes: Option<u64>,
    pub swap_counts_as_ram: bool,
}

/// A loaded scenario collection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfoResult {
    pub status: OkStatus,
    pub name: Option<String>,
    pub default_scenario: String,
    pub scenarios: Vec<CollectionScenario>,
    pub engine_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_policy: Option<ResourcePolicy>,
    /// Diagnostic; its fields may change.
    pub memory: Value,
    /// Resident scenarios and shared timetable accounting. Diagnostic.
    pub residency: Value,
    /// Allocator statistics when available. Diagnostic.
    pub allocator: Value,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CollectionScenario {
    pub id: String,
    pub name: Option<String>,
}

/// `stream --stream-output=detailed`: the internal result without a public
/// projection. `trace` is the unstable internal ABI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StreamDetail {
    pub status: OkStatus,
    pub id: Value,
    pub trace: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorResult {
    pub status: ErrorStatus,
    pub error: ErrorDetail,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

/// Handle `code` and the HTTP status, not message text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorDetail {
    /// Such as `invalid_request`, `stop_not_found`, `scenario_not_found`,
    /// `unsupported_mode`, `file_not_found`, `permission_denied` or
    /// `city_unavailable`.
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AllDayQuery {
    pub start_minutes: u32,
    pub end_minutes: u32,
    pub step_minutes: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AllDaySummary {
    pub sample_count: u32,
    pub step_minutes: u32,
    pub end_exclusive: bool,
    pub aggregation: String,
    pub mean_condition: String,
    pub walking_preparation: String,
}
