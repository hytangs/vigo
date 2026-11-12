//! `vigo capabilities` and `GET /v1/capabilities`: what this executable supports.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Check these before relying on an optional feature.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// `vigo.standalone.capabilities.v1`.
    pub schema_version: String,
    /// Executable version.
    pub version: String,
    /// `rust`.
    pub runtime: String,
    pub standalone: bool,
    pub commands: Vec<String>,
    pub modes: Vec<String>,
    pub time_preferences: Vec<String>,
    pub city_format: String,
    pub routing_store_format: String,
    pub request_schema: String,
    pub data_preparation: String,
    /// `vigo build` options. Absent on runtimes that only open prepared Cities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<BuildCapabilities>,
    pub output: OutputCapabilities,
    pub route: RouteCapabilities,
    pub matrix: MatrixCapabilities,
    pub reach: ReachCapabilities,
    pub compare: CompareCapabilities,
    pub wheelchair: WheelchairCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flex: Option<FlexCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monte_carlo: Option<MonteCarloCapabilities>,
    pub scenario_collections: CollectionCapabilities,
    pub http: HttpCapabilities,
    pub native_operations: Vec<String>,
    pub compatibility: CompatibilityCapabilities,
}

/// City compilation from GTFS ZIPs and an OpenStreetMap PBF.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BuildCapabilities {
    /// Accepted `--street-modes` values.
    pub street_modes: Vec<String>,
    /// Accepted `--private-access` values.
    pub private_access: Vec<String>,
    /// Accepted `--wheelchair-streets` evidence for a wheelchair City.
    pub wheelchair_streets: Vec<String>,
    /// Several scoped GTFS feeds in one City.
    pub multiple_feeds: bool,
    /// `--prepare-date` compiles service dates ahead of queries.
    pub prepare_dates: bool,
    /// `--streets-from` reuses another City's identical streets.
    pub shared_streets: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MonteCarloCapabilities {
    pub commands: Vec<String>,
    pub method: String,
    pub scheduled_only: bool,
    pub planned_services: bool,
    pub phasing: bool,
    pub maximum_draws: u32,
    pub maximum_observation_bytes: u64,
    pub accessibility: bool,
}

/// Conditional GTFS service supported by this executable. Absent on older runtimes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FlexCapabilities {
    pub commands: Vec<String>,
    pub opt_in: bool,
    pub direct_only: bool,
    pub conditional_booking: bool,
    pub confirms_availability: bool,
    pub maximum_matrix_cells: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transit_transfers: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuous_stopping: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheelchair: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutputCapabilities {
    pub schemas: Vec<String>,
    pub stream_formats: Vec<String>,
    pub diagnostics: Vec<String>,
    pub clock: String,
    pub duration_unit: String,
    pub geometry: String,
    pub trace: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RouteCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journey_policies: Option<Vec<String>>,
    pub realtime: bool,
    pub transfer_controls: bool,
    pub waypoints: bool,
    pub departure_windows: bool,
    pub arrival_windows: bool,
    pub alternatives: SampledAlternatives,
    pub requested_alternatives: RequestedAlternatives,
    pub transit_shapes: bool,
    pub fare_annotations: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SampledAlternatives {
    pub coverage: String,
    pub maximum: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestedAlternatives {
    pub maximum: u32,
    pub rankings: Vec<String>,
    pub time_preferences: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCapabilities {
    pub journeys: bool,
    pub journey_geometry: bool,
    pub traffic: bool,
    pub realtime_transit: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReachCapabilities {
    pub modes: Vec<String>,
    pub time_preferences: Vec<String>,
    pub raster: bool,
    pub geojson: bool,
    pub streets: bool,
    pub realtime_transit: bool,
    pub scenarios: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompareCapabilities {
    pub kinds: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WheelchairCapabilities {
    pub supported: bool,
    pub requires_city_profile: String,
    pub modes: Vec<String>,
    pub data_mode: String,
    pub unknown_data: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCapabilities {
    pub format: String,
    pub selector: String,
    pub shared_streets: bool,
    pub bounded_residency: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HttpCapabilities {
    pub max_request_bytes: u64,
    pub max_worker_response_bytes: u64,
    pub bounded_connections: bool,
    pub bounded_queue: bool,
    pub worker_termination_on_deadline: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityCapabilities {
    pub automatic_editor_branch_retiming: bool,
    pub studio_result_envelope: bool,
}
