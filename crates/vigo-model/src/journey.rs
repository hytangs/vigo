//! Journeys and their legs, shared by Route and Matrix Results.

use crate::{Coordinate, Identifier, LineString, Maybe, Number};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// One way to make the trip. Clocks are service-day `HH:MM:SS` (hours may
/// exceed 23); durations are integer seconds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Journey {
    /// Date anchoring every clock in this journey. Route only; `null` for a
    /// walking or driving journey without a service date.
    #[serde(default, skip_serializing_if = "Maybe::is_absent")]
    pub clock_date: Maybe<String>,
    pub departure_time: String,
    pub arrival_time: String,
    pub duration_seconds: i64,
    pub walking_seconds: Option<i64>,
    /// Gaps before and between legs. Not a reliability margin.
    pub waiting_seconds: Option<i64>,
    pub riding_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driving_seconds: Option<i64>,
    pub boardings: u32,
    pub transfers: Option<u32>,
    pub legs: Vec<Leg>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Leg {
    Walk(StreetLeg),
    Transit(Box<TransitLeg>),
    Drive(StreetLeg),
}

/// A place on a journey. A free coordinate has no `stop` or `name`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Endpoint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Identifier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate: Option<Coordinate>,
}

/// A walking or driving leg.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StreetLeg {
    pub from: Endpoint,
    pub to: Endpoint,
    pub departure_time: Option<String>,
    pub arrival_time: Option<String>,
    pub duration_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance_meters: Option<i64>,
    pub quality: StreetQuality,
    /// Street and station costs and their sources, when station access applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub components: Option<Vec<AccessComponent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_connector: Option<EndpointConnector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<LineString>,
}

/// A ride on one scheduled trip.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransitLeg {
    pub from: Endpoint,
    pub to: Endpoint,
    pub departure_time: Option<String>,
    pub arrival_time: Option<String>,
    pub duration_seconds: Option<i64>,
    /// Length of the returned line, boarding to alighting stop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance_meters: Option<i64>,
    pub route: TransitRoute,
    pub trip: Option<Identifier>,
    pub service: Option<Identifier>,
    pub service_date: Option<String>,
    pub direction_id: Option<String>,
    pub headsign: Option<String>,
    pub trip_short_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<InSeatContinuation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intermediate_stops: Option<Vec<IntermediateStop>>,
    pub quality: TransitQuality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fare: Option<Fare>,
    /// Service Alerts active during the ride for its trip, route or stops.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alerts: Option<Vec<LegAlert>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_connector: Option<EndpointConnector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<LineString>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LegAlert {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub effect: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransitRoute {
    pub id: Option<Identifier>,
    /// Short name, else long name.
    pub name: Option<String>,
    pub short_name: Option<String>,
    pub long_name: Option<String>,
    /// GTFS `route_color`, without `#`; empty when the feed gives none.
    pub color: Option<String>,
    /// GTFS `route_type`.
    #[serde(rename = "type")]
    pub route_type: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateStop {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Identifier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate: Option<Coordinate>,
    pub arrival_time: Option<String>,
    pub departure_time: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StreetVerification {
    Verified,
    Unverified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StationPath {
    /// A published GTFS pathway.
    SourcePath,
    Inferred,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StationTime {
    /// Untimed stairs or gates priced by routing estimates.
    Estimated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleQuality {
    /// Modeled timetable times, not observed punctuality.
    Timetable,
    /// The source repeats times or bridges untimed stops.
    SourceTimeLimitations,
    /// Realtime predictions for this trip were applied.
    Realtime,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StreetQuality {
    pub street_geometry: StreetVerification,
    /// Where the line came from: `osm`, `osm_and_station_path`, `gtfs_pathway`,
    /// `station_selection`, `unverified_transfer` or `unknown`. Treat other
    /// values as unverified.
    pub geometry_source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub station_path: Option<StationPath>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub station_time: Option<StationTime>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransitQuality {
    /// Where the line came from: `gtfs_shape` (aligned to the feed's shape),
    /// `stop_sequence` (straight lines between stops) or `unknown`.
    pub geometry: String,
    pub schedule: ScheduleQuality,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AccessComponentType {
    Street,
    Station,
}

/// One part of an access walk's cost.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessComponent {
    #[serde(rename = "type")]
    pub component_type: AccessComponentType,
    pub duration_seconds: Option<i64>,
    pub distance_meters: Option<i64>,
    /// Evidence types, sorted and unique, such as `osm` or `gtfs_pathway`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
}

/// The straight hop between a free coordinate and its street attachment.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EndpointConnector {
    /// `coordinate-snap`.
    pub source: String,
    pub street_path_verified: bool,
    pub distance_km: Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinates: Option<[Coordinate; 2]>,
}

/// The published fare for a ride, or why there is none.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Fare {
    Published(PublishedFare),
    Unavailable(UnavailableFare),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublishedFare {
    /// `GTFS Fares v1` or `GTFS Fares v2`.
    pub standard: String,
    /// The feed the fare came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub options: Vec<FareOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agency_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FareOption {
    pub product_id: String,
    pub name: String,
    pub amount: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// Fare media name; empty when unspecified.
    pub media: String,
    /// Fares v2 only; empty when unspecified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rider_category: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UnavailableFare {
    /// Such as `missing_catalog`, `no_rule` or `invalid_data`.
    pub code: String,
    pub reason: String,
}

/// An explicit GTFS continuation from the preceding transit leg.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InSeatContinuation {
    #[serde(rename = "type")]
    pub kind: InSeatContinuationType,
    pub duration_seconds: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub enum InSeatContinuationType {
    #[serde(rename = "stay_aboard")]
    StayAboard,
}
