//! Requests for Route, Matrix, Reach and Compare.
//!
//! Field names, units and defaults are those of the `/v1` HTTP API, the CLI
//! `--request` file and the resident stream. Optional fields stay absent when
//! unset; the engine applies the documented default.

use crate::common::present;
use crate::{Bounds, Clock, Coordinate, DataMode, Maybe, Mode, Number, ReachMode};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A place: a bare `[longitude, latitude]`, or an object naming a stop and/or
/// coordinate. A selected stop overrides the coordinate unless `source` is
/// `map`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Point {
    Coordinate(Coordinate),
    Place(Box<Place>),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Place {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub stop: Option<StopInput>,
    /// Older form of `stop`: an ID, scoped as `feed` + U+001F + `id`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub stop_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub coordinate: Option<Coordinate>,
    /// Caller's label for a Matrix endpoint, echoed in `query`.
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub label: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub source: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub edit_status: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub baseline_stop_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub baseline_stop_index: Option<u32>,
}

/// A stop reference. Omit `feed`, or send `null`, for an unscoped feed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StopInput {
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub feed: Maybe<String>,
    pub id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticsLevel {
    None,
    Summary,
    Profile,
    Trace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ServiceDay {
    Weekday,
    Saturday,
    Sunday,
}

/// `depart` and `arrive` are accepted aliases.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimePreferenceInput {
    DepartAt,
    ArriveBy,
    Depart,
    Arrive,
}

/// Reach searches forward in time only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReachTimePreference {
    DepartAt,
    Depart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AlternativeRanking {
    /// Nondominated arrival, boarding and walking trade-offs.
    Pareto,
    /// The earliest distinct vehicle sequences, dominated ones included.
    Ranked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum JourneyFormat {
    Full,
    /// The exact timed trip, stop and boarding witness, without display
    /// metadata or walking evidence.
    Compact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReachFormat {
    Full,
    /// Areas for the full reached extent, without rasters or stop lists.
    Map,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceSampling {
    Street,
    CellCenter,
}

/// Defines a query request: the fields given, then the options every query
/// shares, so each request is one flat object in the schema.
macro_rules! query_request {
    ($(#[$meta:meta])* $name:ident { $($fields:tt)* }) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            $($fields)*
            /// Added detail: `summary` counters, `profile` timings, or the
            /// unstable internal `trace`. Default `none`.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(extend("default" = "none"))]
            pub diagnostics: Option<DiagnosticsLevel>,
            /// Add the City's dataset limitations to the Result. Default `false`.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(extend("default" = false))]
            pub include_limitations: Option<bool>,
            /// Query kind on a resident stream.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            pub kind: Option<String>,
            /// Caller's identifier, echoed as `id` and `meta.requestId`.
            #[serde(default, skip_serializing_if = "Maybe::is_absent")]
            pub id: Maybe<Value>,
            /// Member of the loaded scenario collection; omitted selects its default.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            pub scenario_id: Option<String>,
            /// Require a City prepared with the wheelchair-strict-v1 profile.
            /// Omitted inherits the City's profile; `false` rejects a wheelchair City.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            pub wheelchair: Option<bool>,
            /// `YYYY-MM-DD`. Required for transit.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(extend("format" = "date"))]
            pub service_date: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            pub service_day: Option<ServiceDay>,
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            pub time: Option<Clock>,
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(range(min = 0, max = 4319))]
            pub time_minutes: Option<Number>,
            /// Default 1.2.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(range(min = 0, max = 100), extend("default" = 1.2))]
            pub max_walk_km: Option<Number>,
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(range(min = 0, max = 31))]
            pub max_transfers: Option<u32>,
            /// Default `true`.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(extend("default" = true))]
            pub allow_street_transfers: Option<bool>,
            /// Default 0.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(range(min = 0, max = 60), extend("default" = 0))]
            pub minimum_transfer_buffer_minutes: Option<u32>,
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(extend("default" = false))]
            pub disable_cache: Option<bool>,
            /// Default from the City. Walking Route and Matrix, and Reach.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(range(min = 1, max = 8))]
            pub walk_speed_kph: Option<Number>,
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            #[schemars(extend("default" = false))]
            pub require_complete_service_coverage: Option<bool>,
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            pub routing_data_mode: Option<DataMode>,
            /// Alias of `routingDataMode`.
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            pub data_mode: Option<DataMode>,
        }
    };
}

query_request! {
    /// `POST /v1/route`: journeys between two places.
    RouteRequest {
        /// Include GeoJSON on legs.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = true))]
        pub include_geometry: Option<bool>,
        pub origin: Point,
        pub destination: Point,
        /// Ordered intermediate places.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(length(min = 0, max = 16))]
        pub via: Option<Vec<Point>>,
        /// Alias of `via`.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(length(min = 0, max = 16))]
        pub waypoints: Option<Vec<Point>>,
        /// Default `depart_at`.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "depart_at"))]
        pub time_preference: Option<TimePreferenceInput>,
        /// Default `transit`.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "transit"))]
        pub mode: Option<Mode>,
        /// Default 50.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 0.05, max = 1000), extend("default" = 50))]
        pub max_street_km: Option<Number>,
        /// Default 480.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 1, max = 2880), extend("default" = 480))]
        pub horizon_minutes: Option<Number>,
        /// Default `false`: a direct walk may answer the query.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = false))]
        pub require_transit_ride: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = true))]
        pub allow_long_walk: Option<bool>,
        /// Arrival reserve for arrive-by transit without via points.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 0, max = 60), extend("default" = 0))]
        pub arrival_buffer_minutes: Option<u32>,
        /// Sample later departures (or earlier deadlines) over this many minutes.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 0, max = 240), extend("default" = 0))]
        pub window_minutes: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 1, max = 60), extend("default" = 1))]
        pub window_step_minutes: Option<Number>,
        /// Additional depart-at transit journeys; 0 turns alternatives off.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 0, max = 9), extend("default" = 0))]
        pub alternatives: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "pareto"))]
        pub alternative_ranking: Option<AlternativeRanking>,
        /// Latest admitted arrival, in minutes after the primary arrival. Default 15.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 0, max = 120), extend("default" = 15))]
        pub alternative_slack_minutes: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        pub realtime_snapshot: Option<RealtimeSnapshot>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        pub traffic: Option<Traffic>,
    }
}

query_request! {
    /// `POST /v1/matrix`: travel times between every origin and destination.
    MatrixRequest {
        /// Include GeoJSON on legs.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = false))]
        pub include_geometry: Option<bool>,
        #[schemars(length(min = 1, max = 65536))]
        pub origins: Vec<Point>,
        #[schemars(length(min = 1, max = 65536))]
        pub destinations: Vec<Point>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = false))]
        pub include_journeys: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "full"))]
        pub journey_format: Option<JourneyFormat>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "depart_at"))]
        pub time_preference: Option<TimePreferenceInput>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "transit"))]
        pub mode: Option<Mode>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 0.05, max = 1000), extend("default" = 50))]
        pub max_street_km: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 1, max = 2880), extend("default" = 480))]
        pub horizon_minutes: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = false))]
        pub require_transit_ride: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = true))]
        pub allow_long_walk: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 0, max = 60), extend("default" = 0))]
        pub arrival_buffer_minutes: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        pub traffic: Option<Traffic>,
    }
}

query_request! {
    /// `POST /v1/reach` (and `/v1/isochrone`): where an origin reaches within cutoffs.
    ReachRequest {
        /// Include GeoJSON on legs.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = false))]
        pub include_geometry: Option<bool>,
        pub origin: Point,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "depart_at"))]
        pub time_preference: Option<ReachTimePreference>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "transit"))]
        pub mode: Option<ReachMode>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "full"))]
        pub reach_format: Option<ReachFormat>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = "street"))]
        pub surface_sampling: Option<SurfaceSampling>,
        /// Default `[15, 30, 45, 60]`.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(length(min = 1, max = 16), inner(range(min = 1, max = 240)), extend("default" = [15, 30, 45, 60]))]
        pub cutoffs_minutes: Option<Vec<Number>>,
        /// Cells per side. Default 96.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 16, max = 1024), extend("default" = 96))]
        pub raster_size: Option<u32>,
        /// Default 8.
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(range(min = 1, max = 40), extend("default" = 8))]
        pub extent_radius_km: Option<Number>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(length(min = 4, max = 4))]
        pub bounds: Option<Bounds>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = false))]
        pub include_street_edges: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        #[schemars(extend("default" = false))]
        pub include_nodes: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        pub scenario: Option<Scenario>,
    }
}

/// `POST /v1/compare`: two saved Results of the same query family.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompareRequest {
    /// A saved `vigo.route.v1`, `vigo.matrix.v1` or `vigo.reach.v1` Result.
    /// Internal trace results are also accepted, without stability guarantees.
    pub before: Value,
    /// A Result of the same family as `before`.
    pub after: Value,
    /// `trace` adds the internal comparison.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub diagnostics: Option<DiagnosticsLevel>,
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub id: Maybe<Value>,
}

/// A request-scoped service change. Use `services` or a compiled `overlay`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scenario {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub city_revision: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(length(min = 0, max = 128))]
    pub services: Option<Vec<ScenarioService>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub excluded_trip_ids: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub excluded_route_ids: Option<Vec<String>>,
    /// A compiled native overlay; see the native field reference.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub overlay: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ServiceOperation {
    Add,
    Augment,
    Replace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduleMode {
    Frequency,
    PreserveTrips,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TimeModel {
    EstimateDistance,
    PreserveScheduled,
    InferRoad,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioService {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub name: Option<String>,
    /// Default `add`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(extend("default" = "add"))]
    pub operation: Option<ServiceOperation>,
    /// At least two places, in service order.
    #[schemars(length(min = 2))]
    pub stops: Vec<Point>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub schedule_mode: Option<ScheduleMode>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub source_route_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub scheduled_trips: Option<Vec<ScheduledTrip>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub bidirectional: Option<bool>,
    /// Default 300.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(range(min = 0, max = 4319), extend("default" = 300))]
    pub start_minutes: Option<Number>,
    /// Default 1500.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(range(min = 0, max = 4319), extend("default" = 1500))]
    pub end_minutes: Option<Number>,
    /// Default 12.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(range(min = 0.1, max = 1440), extend("default" = 12))]
    pub headway_minutes: Option<Number>,
    /// Default `estimate-distance`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(extend("default" = "estimate-distance"))]
    pub time_model: Option<TimeModel>,
    /// Default 22.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(range(min = 1, max = 300), extend("default" = 22))]
    pub average_speed_kph: Option<Number>,
    /// Default 0.35.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(range(min = 0, max = 60), extend("default" = 0.35))]
    pub dwell_minutes: Option<Number>,
    /// Default 0.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(range(min = 0, max = 10), extend("default" = 0))]
    pub added_stop_dwell_minutes: Option<Number>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(inner(range(min = 0)))]
    pub segment_runtime_minutes: Option<Vec<Number>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(inner(range(min = 0)))]
    pub segment_distances_km: Option<Vec<Number>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTrip {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub trip_id: Option<String>,
    #[schemars(range(min = 0, max = 1048575))]
    pub departure_seconds: Number,
    #[schemars(inner(range(min = 0)))]
    pub arrival_offsets_seconds: Vec<Number>,
    #[schemars(inner(range(min = 0)))]
    pub departure_offsets_seconds: Vec<Number>,
    /// One 0/1 flag per stop.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(inner(range(min = 0, max = 1)))]
    pub can_board: Option<Vec<u8>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[schemars(inner(range(min = 0, max = 1)))]
    pub can_alight: Option<Vec<u8>>,
}

/// A GTFS-Realtime enumeration, by name or by numeric code.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Enumerated {
    Name(String),
    Code(i64),
}

/// Trip Updates applied to one Route request. Freshness is checked against
/// the current time.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeSnapshot {
    /// `FULL_DATASET` or `0`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incrementality: Option<Enumerated>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// POSIX seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub feed_timestamp: Option<u64>,
    #[schemars(length(min = 0, max = 100000))]
    pub trip_updates: Vec<TripUpdate>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TripUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trip_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trip: Option<TripDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction_id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub source_feed_timestamp: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timestamp: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_seconds: Option<i64>,
    /// `SCHEDULED`, `CANCELED` or `DELETED`, or their codes 0, 3 and 7.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_relationship: Option<Enumerated>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_time_updates: Option<Vec<StopTimeUpdate>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TripDescriptor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trip_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StopTimeUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0, max = 4_294_967_295_u64))]
    pub stop_sequence: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_id: Option<String>,
    /// `SCHEDULED`, `SKIPPED` or `NO_DATA`, or their codes 0 to 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_relationship: Option<Enumerated>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrival: Option<StopTimeEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub departure: Option<StopTimeEvent>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StopTimeEvent {
    /// POSIX seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0))]
    pub time: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0))]
    pub uncertainty: Option<Number>,
}

/// Supplied traffic for driving: prepared edge times, or observations.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Traffic {
    Prepared(PreparedTraffic),
    Observed(ObservedTraffic),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTraffic {
    pub snapshot_key: String,
    pub street_source_fingerprint: String,
    pub edge_indices: Vec<u32>,
    pub edge_time_units: Vec<u32>,
    /// Required freshness for prepared traffic; edge costs never remain live indefinitely.
    pub observed_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Provider import diagnostics, outside the stable routing contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingestion: Option<serde_json::Value>,
}

/// POSIX milliseconds, or an RFC 3339 date-time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Timestamp {
    Millis(Number),
    Text(String),
}

/// Observed traffic. One of `observedAt`, `fetchedAt` or `timestamp` is
/// required, and one of `observations`, `segments` or `edgeUpdates`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ObservedTraffic {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snap_radius_meters: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
    /// Default 300.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub street_source_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observations: Option<Vec<TrafficObservation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<TrafficObservation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_updates: Option<Vec<TrafficObservation>>,
}

/// Directed geometry or edge indices, and exactly one cost effect.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrafficObservation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinates: Option<Vec<Coordinate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_coordinate: Option<Coordinate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_coordinate: Option<Coordinate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_indices: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub travel_time_seconds: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_kph: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_factor: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factor: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiplier: Option<Number>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The engine rejects these with `invalid_request`; so does the model.
    #[test]
    fn requests_reject_what_the_engine_rejects() {
        let base = json!({ "serviceDate": "2026-07-15", "time": "07:55", "origin": { "stopId": "A" },
            "destination": { "stop": { "feed": null, "id": "B" } }, "maxWalkKm": 0.2 });
        assert!(serde_json::from_value::<RouteRequest>(base.clone()).is_ok());
        for (key, value) in [
            ("bogus", json!(1)),
            ("maxWalkKm", json!(null)),
            ("includeGeometry", json!(null)),
            ("mode", json!(null)),
        ] {
            let mut request = base.clone();
            request[key] = value;
            assert!(
                serde_json::from_value::<RouteRequest>(request).is_err(),
                "{key} accepted"
            );
        }
        let mut request = base.clone();
        request["origin"]["bogus"] = json!(1);
        assert!(
            serde_json::from_value::<RouteRequest>(request).is_err(),
            "unknown point field accepted"
        );
        let mut reach =
            json!({ "origin": [-77.05, 38.9], "time": "07:55", "cutoffsMinutes": [15] });
        assert!(serde_json::from_value::<ReachRequest>(reach.clone()).is_ok());
        reach["bogus"] = json!(true);
        assert!(serde_json::from_value::<ReachRequest>(reach).is_err());
    }
}
